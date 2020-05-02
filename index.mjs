import axios from 'axios'
import lame from 'lame'

// import Noodle from 'noodle.js'
import mumble from 'mumble'

import d3 from 'd3-array'
import ytdl from 'ytdl-core'
import ffmpeg from 'fluent-ffmpeg'
import dotenv from 'dotenv'
import { stringify as qs } from 'querystring'
import { EventEmitter } from 'events'
import { readFileSync as readFile, promises as fs } from 'fs'
import server from 'fastify'
import websockets from 'fastify-websocket'
import { renderFile as render } from 'pug'

dotenv.config()

const {
  PLAYLIST = 'PLl2JADJwpokG_bQWijyL6td759TiIhGhw',
  NAME = 'radio_bot',
  YOUTUBE_API_KEY,
  HOST,
  PORT = 64738,
  WEB_PORT,
  KEY_FILE,
  CERT_FILE
} = process.env

const fetchPlaylist = async (pageToken = '') => {
  const query = qs({
    part: 'snippet',
    maxResults: 50,
    playlistId: PLAYLIST,
    pageToken: pageToken,
    key: YOUTUBE_API_KEY
  })

  const { data: { nextPageToken, items } } = await axios.get(`https://www.googleapis.com/youtube/v3/playlistItems?${query}`)

  const snippets = items.map(({ snippet: { title, resourceId: { videoId: id } } }) => ({
    title, id
  }))

  if (nextPageToken) {
    return [ ...snippets, ...await fetchPlaylist(nextPageToken) ]
  }

  return snippets
}

const getAudioStream = async (id) => {
  const stream = ytdl(id, {
    quality: 'highestaudio'
  })

  // Normalize audio volume
  const ffmpegStream = ffmpeg()
    .input(stream)
    .noVideo()
    .format('mp3')
    .audioFilters('loudnorm')
    .audioFrequency(48000)
    .audioChannels(1)
    .pipe()

  stream.once('error', err => {
    console.error('[YTDL]', err)
    bridge.emit('yt:error')
  })

  return ffmpegStream
}

const bridge = new EventEmitter()

console.log('starting client...')
mumble.connect(`mumble://${HOST}:${PORT}`, {
  key: readFile(KEY_FILE),
  cert: readFile(CERT_FILE)
}, (err, conn) => {
  if (err) {
    return console.error('[MUMBLE]', err)
  }

  conn.on('error', err => {
    console.error('[MUMBLE]', err)
    process.exit(1)
  })

  conn.authenticate(NAME)
  conn.on('initialized', () => {
    bridge.emit('ready', conn)
  })
})

const cache = {
  playlist: [],
  nextStream: null,
  nextItem: null
}

const fetchAndShuffle = async (client) => {
  try {
    const playlist = await fetchPlaylist()
    return [ ...cache.playlist, ...d3.shuffle(playlist) ]
  } catch (err) {
    console.error('[FETCH]', err)

    if (client) {
      await client.user.channel.sendMessage(`Error fetching playlist: ${err}`)
    }
  }
}

const nextSong = async (client) => {
  // Fetch if playlist is empty
  if (cache.playlist.length === 0) {
    cache.playlist = await fetchAndShuffle(client)
  }

  // Fetch stream if not fetched already
  if (cache.nextStream === null) {
    const curr = cache.playlist.pop()
    cache.nextStream = await getAudioStream(curr.id)
    cache.nextItem = curr
  }

  const stream = cache.nextStream

  stream.once('error', err => {
    console.error('[FFMPEG]', err)
  })

  bridge.emit('song', cache.nextItem.title)

  console.log(cache.nextItem.title)
  const decoder = new lame.Decoder()
  const decodedStream = stream.pipe(decoder)

  decoder.on('format', format => {
    decodedStream.pipe(client.inputStream({
      channels: format.channels,
      sampleRate: format.sampleRate
    }))
  })

  decodedStream.once('end', () => {
    setTimeout(() => {
      nextSong(client)
    }, 2000)
  })

  await client.user.channel.sendMessage(cache.nextItem.title)

  // Fetch next stream
  cache.nextItem = cache.playlist.pop()
  cache.nextStream = await getAudioStream(cache.nextItem.id)

  // Fetch if playlist has only 1 element
  if (cache.playlist.length === 1) {
    cache.playlist = await fetchAndShuffle(client)
  }
}

bridge.on('ready', (client, voice) => {
  console.log('connected!')

  bridge.on('yt:error', async err => {
    client.user.channel.sendMessage(`[ERROR] ${cache.nextItem.title} - ${err.message}`)
    cache.nextItem = cache.playlist.pop()
    cache.nextStream = await getAudioStream(cache.nextItem.id)
  })

  client.on('message', message => {
    if (message[0] !== '!') {
      return
    }

    switch (message.slice(1)) {
      case 'p':
      case 'playlist':
        client.user.channel.sendMessage(`Playlist: ${PLAYLIST}`)
        break

      case 'r':
      case 'restart':
        console.log(`${'-'.repeat(7)}  RESTART  ${'-'.repeat(7)}`)
        process.exit(0)
        break

      case 'l':
      case 'list':
      case 'songs':
        const list = cache.playlist.slice(-7)
          .map(({ title }) => title)
          .join('<br>')

        client.user.channel.sendMessage(`Songlist:<br>${list}`)
        break
    }
  })

  nextSong(client, voice)
})

if (WEB_PORT) {
  console.log('starting web server...')

  const fastify = server()
  fastify.register(websockets)

  let song

  fastify.get('/obs/:style', async (request, reply) => {
    const { style } = request.params

    if (await fs.exists(`public/obs/${style}.pug`)) {
      return render(`public/obs/${style}.pug`, {
        song
      })
    }

    return render('public/obs/plain.pug', {
      song
    })
  })

  fastify.get('/api/v1/song', async (request, reply) => {
    if (song === undefined) {
      reply.code(425)
      return { error: 'radio:loading' }
    }

    return { title: song }
  })

  fastify.get('/api/v1/list', async (request, reply) => {
    return cache.playlist
  })

  // Websockets
  fastify.get('/', { websocket: true }, ({ socket }) => {
    socket.send(JSON.stringify({ title: song }))
  })

  bridge.on('song', title => {
    song = title

    // Send update to all websockets
    for (const socket of fastify.websocketServer.clients) {
      if (socket.readyState !== 1) {
        continue
      }

      socket.send(JSON.stringify({ title: song }))
    }
  })

  fastify.listen(WEB_PORT)
}
