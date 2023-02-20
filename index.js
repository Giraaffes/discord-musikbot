const discord = require("discord.js");
const discordVoice = require('@discordjs/voice');
const ytdl = require("ytdl-core");
const ytsr = require("ytsr");

const token = "ODY2MzgzNDc4MjYyMzMzNDQx.GoqgJn.tgJ_PL_Lbs-L2gS-9dLr_ySTl-SLBLlFLS3Qhc";

const cmdRegex = /^\s*\$([\wæøå]+)\s*(.*)$/i;
const ytUrlRegex = /^(?:http(?:s)?:\/\/)?(?:(?:www\.)?youtube\.com\/(?:watch\?v=|v\/)|youtu\.be\/)[^#&?\s]+/i;
const musicVideoRegex = /music\s+video|official\s+video/i;


const bot = new discord.Client({
	intents: [
		discord.GatewayIntentBits.Guilds,
		discord.GatewayIntentBits.GuildMessages,
		discord.GatewayIntentBits.GuildMessageReactions,
		discord.GatewayIntentBits.GuildVoiceStates,
		discord.GatewayIntentBits.MessageContent
	]
});


let voiceStates = new discord.Collection();
let connections = new discord.Collection();

// This should probably be per-server as well
let audioPlayer = discordVoice.createAudioPlayer(); 
let queue = [];
let paused = false;
let stopSilently = false;
let currentChannel;


async function joinCmd(msg) {
	let voiceChannel = msg.member.voice.channel;
	if (!voiceChannel) {
		await msg.channel.send("Du skal være i en kanal!");
		return false;
	} else if (voiceStates.has(msg.guild.id) && voiceStates.get(msg.guild.id).channelId == voiceChannel.id) {
		await msg.channel.send("Jeg er allerede i den her kanal?");
		return false;
	} else if (!voiceChannel.joinable) {
		await msg.channel.send("Jeg har ikke adgang til din kanal :(");
		return false;
	}
	
	let conn = discordVoice.joinVoiceChannel({
		channelId: voiceChannel.id,
		guildId: voiceChannel.guild.id,
		adapterCreator: voiceChannel.guild.voiceAdapterCreator,
	});
	
	let readyPromise = new Promise(res => {
		conn.on(discordVoice.VoiceConnectionStatus.Ready, () => { res(false) });
	});
	let timeoutPromise = new Promise(res => { setTimeout(res, 5000, true) });
	
	let timeout = await Promise.race([timeoutPromise, readyPromise]);
	if (timeout) {
		await msg.channel.send("... Jeg kunne ikke forbinde til kanalen inden for 5 sekunder...");
		conn.disconnect();
		conn.destroy();
		return false;
	} else {
		let voiceState = msg.guild.voiceStates.resolve(bot.user.id);
		voiceStates.set(msg.guild.id, voiceState);
		connections.set(msg.guild.id, conn);
		
		conn.subscribe(audioPlayer);
		return true;
	}
}

async function leaveCmd(msg) {
	let voiceState = voiceStates.get(msg.guild.id);
	if (!voiceState) {
		await msg.channel.send("Jeg er ikke i nogen kanal?");
		return;
	}
	
	queue = [];
	stopAudio(true);
	
	await voiceState.disconnect();
	voiceStates.delete(msg.guild.id);
	connections.delete(msg.guild.id);
	
	await msg.channel.send("👍");
}

async function playCmd(msg, query) {
	if (!query) {
		if (paused) unpauseCmd(msg);
		return;
	}
	if (!connections.has(msg.guild.id) && !(await joinCmd(msg))) return;
	
	msg.channel.sendTyping()
	
	let url;
	let queryUrlMatch = query.match(ytUrlRegex);
	if (queryUrlMatch) {
		url = queryUrlMatch[0];
	} else {
		//let filters = await ytsr.getFilters(query);
		//let filteredUrl = filters.get('Type').get('Video').url;
		let search = await ytsr(query, {
			gl: "DK",
			limit: 10
		});
		
		let isMusicVideoSearch = query.match(musicVideoRegex);
		let results = search.items.filter(e => 
			e.type == "video" && (isMusicVideoSearch || !e.title.match(musicVideoRegex))
		)
		if (results.length == 0) {
			await msg.channel.send("Den sang kan jeg ikke finde :(");
			return;
		}
		
		url = results[0].url;
	}
	
	let stream = ytdl(url, {
		quality: "highestaudio",
		filter: format => format.audioCodec == "opus",
		highWaterMark: 1 << 25,
		dlChunkSize: 0
	});
	
	let infoPromise = new Promise(res => {
		stream.on("info", (info, format) => res({info: info.videoDetails, format}));
	});
	let { info, format } = await infoPromise;
	
	let resource = discordVoice.createAudioResource(stream, {
		inputType: format.container == "webm" ? discordVoice.StreamType.WebmOpus : discordVoice.StreamType.OggOpus
	});
	
	queue.push({ info, resource });
	if (queue.length == 1) {
		await msg.channel.send(`Afspiller 🎶 \`${info.title}\` 🎶`);
		audioPlayer.play(resource);
	} else {
		await msg.channel.send(`🎶 \`${info.title}\` 🎶 er tilføjet til køen!`);
	}
}

async function skipCmd(msg) {
	if (queue.length == 0) {
		await msg.channel.send("Jeg spiller ikke noget?");
	} else {
		await msg.channel.send("Sangen er sprunget over.");
		stopAudio(false);
	}
}

async function pauseCmd(msg) {
	if (queue.length == 0) {
		await msg.channel.send("Jeg spiller ikke noget?");
	} else if (!paused) {
		paused = true;
		audioPlayer.pause();
		await msg.channel.send("Musikken er pauset.");
	} else {
		unpauseCmd(msg);
	}
}

async function unpauseCmd(msg) {
	if (queue.length == 0) {
		await msg.channel.send("Jeg spiller ikke noget?");
	} else if (!paused) {
		await msg.channel.send("Jeg er ikke pauset?");
	} else {
		paused = false;
		audioPlayer.unpause();
		await msg.channel.send("🎶 Musikken er sat i gang igen 🎶");
	}
}

async function showQueueCmd(msg) {
	if (queue.length == 0) {
		await msg.channel.send("Køen er vist tom.");
		return;
	}
	
	let str = "\nSådan her ser køen ud:"; 
	
	str += `\n1. 🎶 \`${queue[0].info.title}\` 🎶`;
	for (let i = 1; i < queue.length; i++) {
		str += `\n${i+1}. \`${queue[i].info.title}\``
	}
	
	await msg.channel.send(str);
}

async function clearQueueCmd(msg) {
	if (queue.length == 0) {
		await msg.channel.send("Køen er allerede tom?");
	} else {
		queue = [queue[0]];
		await msg.channel.send("Køen er ryddet.");
	}
}

async function showSongCmd(msg) {
	if (queue.length == 0) {
		await msg.channel.send("Jeg spiller ikke noget?");
	} else {
		let { title, ownerChannelName, publishDate } = queue[0].info;
		let [ y, m, d ] = publishDate.split("-").map(n => parseInt(n));
		
		let str = `Lige nu spiller jeg 🎶 \`${queue[0].info.title}\` 🎶\n`;
		str += `Videoen er uploadet af \`${queue[0].info.ownerChannelName}\` `;
		str += `d. ${d}/${m} ${y}.`
		await msg.channel.send(str);
	}
}

function stopAudio(silent) {
	if (silent) stopSilently = true;
	audioPlayer.stop();
}

function songFinished() {
	if (stopSilently) {
		stopSilently = false;
		return;
	}
	
	if (queue.length > 0) queue.splice(0, 1);
	if (queue.length == 0) {
		currentChannel.send("Køen er tom!");
	} else {
		let nextSong = queue[0];
		currentChannel.send(`🎶 Afspiller \`${nextSong.info.title}\` 🎶`);
		audioPlayer.play(nextSong.resource);
	}
}


bot.on("ready", async () => {
	console.log("Ready");
	
	let guilds = await bot.guilds.fetch();
	for (let guildId of guilds.keys()) {
		guild = bot.guilds.resolve(guildId);
		let voiceState = guild.voiceStates.resolve(bot.user.id);
		if (voiceState) await voiceState.disconnect();
	} 
});

bot.on("messageCreate", async (msg) => {
	if (msg.author.bot) return;
	
	let match = msg.content.match(cmdRegex);
	if (!match) return;
	
	let cmd = match[1].toLowerCase();
	let args = match[2].trim();
	
	try {
		switch (cmd) {
			case "join": 
				await joinCmd(msg); break;
			case "leave": 
			case "skrid":
			case "stop":
				await leaveCmd(msg); break;
			case "play": 
			case "afspil":
			case "spil":
				await playCmd(msg, args); break;
			case "skip": 
			case "springover":
				await skipCmd(msg); break;
			case "paus":
			case "pause": 
				await pauseCmd(msg); break;
			case "unpause": 
			case "unpaus": 
			case "start":
				await unpauseCmd(msg); break;
			case "queue":
			case "kø":
				await showQueueCmd(msg); break;
			case "clear":
			case "clearqueue":
			case "rydkø":
			case "rydkøen":
				await clearQueueCmd(msg); break;
			case "song":
			case "songname":
			case "sang":
			case "sangnavn":
				await showSongCmd(msg); break;
			default: return;
		}
	} catch (e) {
		console.warn(e);
		await msg.channel.send("Der skete en fejl... :(");
	}
	currentChannel = msg.channel;
});

audioPlayer.on(discordVoice.AudioPlayerStatus.Idle, songFinished);


bot.login(token);