const discord = require("discord.js");
const discordVoice = require('@discordjs/voice');
const discordToken = "ODY2MzgzNDc4MjYyMzMzNDQx.GoqgJn.tgJ_PL_Lbs-L2gS-9dLr_ySTl-SLBLlFLS3Qhc";

const spotify = require("spotify-web-api-node");
const clientId = "ef487cee65cd4e8199a5b5bb1cbf8b50";
const clientSecret = "4f81fab39e8040648a007638baa04861";

const ytdl = require("ytdl-core");
const ytsr = require("ytsr");
const ytpl = require("ytpl");

const cmdRegex = /^\s*\$([\wæøå]+)\s*(.*)$/i;
const ytUrlRegex = /^(?:http(?:s)?:\/\/)?(?:(?:www\.)?youtube\.com\/(?:watch\?v=|v\/)|youtu\.be\/)[^#&?\s]+/i;
const songFilterRegex = /music video|official video|live performance|\(live\)|full album|music festival/i;
const spotifyPlaylistUrlRegex = /^(?:http(?:s)?:\/\/)?open\.spotify\.com\/playlist\/([^?]+)/;


const bot = new discord.Client({
	intents: [
		discord.GatewayIntentBits.Guilds,
		discord.GatewayIntentBits.GuildMessages,
		discord.GatewayIntentBits.GuildMessageReactions,
		discord.GatewayIntentBits.GuildVoiceStates,
		discord.GatewayIntentBits.MessageContent
	]
});

const spotifyApi = new spotify({clientId, clientSecret});


let voiceStates = new discord.Collection();
let connections = new discord.Collection();

// This should probably be per-server as well
let audioPlayer = discordVoice.createAudioPlayer(); 
let queue = [];
let paused = false;
let stopSilently = false;
let currentChannel;


function stopAudio(silent) {
	if (silent) stopSilently = true;
	audioPlayer.stop();
}

async function fetchSong(url) {
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
	
	return {info, resource};
}

async function quickSearchSong(name) {
	let search = await ytsr(name, {
		gl: "DK",
		limit: 3
	});
	
	let results = search.items.filter(e => 
		e.type == "video" && !e.title.match(songFilterRegex)
	)
	if (results.length == 0) return null;
	let song = await fetchSong(results[0].url);
	return song;
}


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
	
	msg.channel.sendTyping();
	
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
		
		let isUnfilteredSearch = query.match(songFilterRegex);
		let results = search.items.filter(e => 
			e.type == "video" && (isUnfilteredSearch || !e.title.match(songFilterRegex))
		)
		if (results.length == 0) {
			await msg.channel.send("Den sang kan jeg ikke finde :(");
			return;
		}
		
		url = results[0].url;
	}
	
	let song = fetchSong(url);
	queue.push(song);
	if (queue.length == 1) {
		await msg.channel.send(`Afspiller 🎶 \`${song.info.title}\` 🎶`);
		audioPlayer.play(song.resource);
	} else {
		await msg.channel.send(`🎶 \`${song.info.title}\` 🎶 er tilføjet til køen!`);
	}
}

async function playPlaylist(msg, query) {
	if (!connections.has(msg.guild.id) && !(await joinCmd(msg))) return;
	
	msg.channel.sendTyping();
	
	let plUrl;
	let queryUrlMatch = query.match(ytUrlRegex);
	if (queryUrlMatch) {
		plUrl = queryUrlMatch[0];
	} else {
		let search = await ytsr(query, {
			gl: "DK",
			limit: 20
		});
		
		let results = search.items.filter(e => 
			e.type == "playlist"
		)
		if (results.length == 0) {
			await msg.channel.send("Den playliste kan jeg ikke finde :(");
			return;
		}
		
		plUrl = results[0].url;
	}
	
	let playlist = await ytpl(plUrl, {limit: 50});
	let songs = playlist.items.sort((a, b) => a.index - b.index);
	
	let firstSong = await fetchSong(songs[0].shortUrl);
	queue.push(firstSong);
	
	let shadows = songs.slice(1).map(s => { return {info: {title: `${s.title} (ikke downloadet)`} }; });
	queue.push(...shadows);
	(async () => {
		for (let i = 1; i < songs.length; i++) {
			let queueIndex = queue.length - songs.length + i;
			queue[queueIndex] = await fetchSong(songs[i].shortUrl);
		}
	})();
	
	await msg.channel.send(`Playlisten 💿 \`${playlist.title}\` 💿 er tilføjet til køen!`);
	if (queue.length == songs.length) {
		await msg.channel.send(`Afspiller 🎶 \`${queue[0].info.title}\` 🎶`);
		audioPlayer.play(queue[0].resource);
	}
}

async function playSpotifyPlaylistCmd(msg, query) {
	if (!connections.has(msg.guild.id) && !(await joinCmd(msg))) return;
	
	msg.channel.sendTyping();
	
	let urlMatch = query.match(spotifyPlaylistUrlRegex);
	let playlistId = urlMatch ? urlMatch[1] : encodeURIComponent(query);
	console.log(playlistId);
	
	let playlist;
	try {
		playlist = (await spotifyApi.getPlaylist(playlistId)).body;
		await msg.channel.send(`Playlisten 💿 \`${playlist["name"]}\` 💿 af brugeren \`${playlist["owner"]["display_name"]}\` er tilføjet til køen!`);
	} catch (e) {
		if (e.body.error.message != "Invalid playlist Id") throw e;
	}
	
	if (!playlist) {
		let search = (await spotifyApi.searchPlaylists(query, {limit: 1, market: "DK"})).body;
		let results = search["playlists"]["items"];
		if (results.length > 0) {
			let id = results[0]["id"];
			playlist = (await spotifyApi.getPlaylist(id)).body;
			await msg.channel.send(`Jeg fandt playlisten 💿 \`${playlist["name"]}\` 💿 af brugeren \`${playlist["owner"]["display_name"]}\`!`);
		}
	}
	
	if (!playlist) {
		await msg.channel.send("Den playlist kunne jeg ikke finde :(");
		return;
	}
	let songNames = playlist["tracks"]["items"].map(item => {
		return `${item["track"]["artists"][0]["name"]} - ${item["track"]["name"]}`;
	});
	
	let firstSong = await quickSearchSong(songNames[0]);
	queue.push(firstSong);
	
	let shadows = songNames.slice(1).map(s => { return {info: {title: `${s} (ikke downloadet)`}}; });
	queue.push(...shadows);
	(async () => {
		for (let i = 1; i < songNames.length; i++) {
			let queueIndex = queue.length - songNames.length + i;
			let song = await quickSearchSong(songNames[i]);
			if (song) {
				queue[queueIndex] = song;
			} else {
				await msg.channel.send(`Jeg kunne ikke finde 🎶 \`${songNames[i]}\` 🎶 på Youtube :(`);
				queue[queueIndex] = {
					title: `${songNames[i]} (kunne ikke findes)`,
					invalid: true
				}
			}
		}
	})();
	
	if (queue.length == songNames.length) {
		await msg.channel.send(`Afspiller 🎶 \`${queue[0].info.title}\` 🎶 mens resten af playlisten downloades...`);
		audioPlayer.play(queue[0].resource);
	} else {
		await msg.channel.send("Playlisten downloades...");
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
	
	str += `\n1. 🔊 \`${queue[0].info.title}\` 🔊`;
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


async function refreshSpotify() {
	let spotifyRes = (await spotifyApi.clientCredentialsGrant()).body;
	spotifyApi.setAccessToken(spotifyRes["access_token"]);
	console.log(`Spotify connected for ${spotifyRes["expires_in"]} seconds`);
	
	setTimeout(() => {
		refreshSpotify();
	}, spotifyRes["expires_in"] * 1000);
}

async function onReady() {
	console.log("Bot ready");
	
	let guilds = await bot.guilds.fetch();
	for (let guildId of guilds.keys()) {
		guild = bot.guilds.resolve(guildId);
		let voiceState = guild.voiceStates.resolve(bot.user.id);
		if (voiceState) await voiceState.disconnect();
	} 
	
	await refreshSpotify();
}

async function onMessage(msg) {
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
			case "playlist":
			case "playliste":
			case "afspilplayliste":
				await playPlaylist(msg, args); break;
			case "spotify":
				await playSpotifyPlaylistCmd(msg, args); break;
			default: return;
		}
	} catch (e) {
		console.warn(e);
		await msg.channel.send("Der skete en fejl... :(");
	}
	currentChannel = msg.channel;
}

function onSongFinished() {
	if (stopSilently) {
		stopSilently = false;
		return;
	}
	
	if (queue.length > 0) queue.splice(0, 1);
	if (queue.length == 0) {
		currentChannel.send("Køen er tom!");
	} else {
		while (queue[0] && queue[0].invalid) queue.splice(0, 1);
		
		let nextSong = queue[0];
		currentChannel.send(`Afspiller 🎶 \`${nextSong.info.title}\` 🎶`);
		audioPlayer.play(nextSong.resource);
	}
}


bot.on("ready", onReady);
bot.on("messageCreate", onMessage);
audioPlayer.on(discordVoice.AudioPlayerStatus.Idle, onSongFinished);

bot.login(discordToken);