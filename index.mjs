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
import pug from 'pug'

dotenv.config()

const { renderFile: render } = pug

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

  try {
    cache.played = JSON.parse(fs.readFile('.cache/data.json'))
  } catch {
    await fs.writeFile('.cache/data.json', [])
  }

  const { data: { nextPageToken, items } } = await axios.get(`https://www.googleapis.com/youtube/v3/playlistItems?${query}`)

  const snippets = items
    .map(({ snippet: { title, resourceId: { videoId: id } } }) => ({
      title, id
    }))
    .filter(({ id }, i) => {
      if (!id) {
        console.log(`Song #${i} is broken`)
        return false
      }

      return !cache.played.includes(id)
    })

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
    bridge.emit('next', err)
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

  conn.on('disconnect', () => {
    console.error('The fuck, disconnect?')
    process.exit(1)
  })

  conn.authenticate(NAME)
  conn.on('initialized', () => {
    bridge.emit('ready', conn)
  })
})

const cache = {
  playlist: [],
  played: [],
  nextStream: null,
  nextItem: null,
  users: [],
  whisperId: -1
}

const fetchAndShuffle = async (client) => {
  try {
    const playlist = await fetchPlaylist()
    return [ ...cache.playlist, ...d3.shuffle(playlist) ]
  } catch (err) {
    console.error('[FETCH]', err)
    return cache.playlist
  }
}

const nextSong = async (client) => {
  // Fetch if playlist is empty
  if (cache.playlist.length === 0) {
    cache.playlist = await fetchAndShuffle(client)
  }

  // Fetch stream if not fetched already
  if (cache.nextStream === null) {
    let error = false

    do {
      try {
        error = false
        cache.nextItem = cache.playlist.pop()
        cache.nextStream = await getAudioStream(cache.nextItem.id)
      } catch (err) {
        error = true
        console.error('[FIRST]', cache.nextItem, err)
      }
    } while (error)
  }

  const stream = cache.nextStream

  stream.once('error', err => {
    console.error('[FFMPEG]', err)
  })

  bridge.emit('song', cache.nextItem.title)

  console.log(cache.nextItem.title)
  const decoder = new lame.Decoder()
  const decodedStream = stream.pipe(decoder)

  cache.played.push(cache.nextItem.id)
  await fs.writeFile('.cache/data.json', JSON.stringify(cache.played))

  decoder.once('format', format => {
    const users = client.users().map(({ session }) => session)

    const input = client.inputStreamForUser(users, {
      channels: format.channels,
      sampleRate: format.sampleRate,
      gain: 0.15
    })

    cache.users = users
    cache.whisperId = input.whisperId

    input.once('finish', async () => {
      await nextSong(client)
    })

    decodedStream.pipe(input)
  })

  client.user.setComment(cache.nextItem.title)

  // Fetch next stream
  bridge.emit('next')

  // Fetch if playlist has only 1 element
  if (cache.playlist.length === 1) {
    await fs.writeFile('.cache/data.json', JSON.stringify(cache.played = []))
    cache.playlist = await fetchAndShuffle(client)
  }
}

bridge.on('ready', async (client, voice) => {
  console.log('connected!')

  bridge.on('next', async () => {
    try {
      cache.nextItem = cache.playlist.pop()
      cache.nextStream = await getAudioStream(cache.nextItem.id)
    } catch (err) {
      console.error(`[ERROR] ${cache.nextItem.title} - ${err.message}`)
      bridge.emit('next')
    }
  })

  client.on('message', (message, user) => {
    if (message[0] !== '!') {
      return
    }

    switch (message.slice(1)) {
      case 'h':
      case 'help':
        user.sendMessage('Commands: !help, !playlist, !list, !restart')
        break

      case 'p':
      case 'playlist':
        user.sendMessage(`Playlist: https://www.youtube.com/playlist?list=${PLAYLIST}`)
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

        user.sendMessage(`Songlist:<br>${list}`)
        break
    }
  })

  await nextSong(client, voice)

  client.on('user-connect', ({ session }) => {
    cache.users.push(session)

    client.connection.sendMessage('VoiceTarget', {
      targets: [{ session: cache.users }],
      id: cache.whisperId
    })
  })

  client.on('user-disconnect', ({ session }) => {
    cache.users.splice(cache.users.indexOf(session), 1)

    client.connection.sendMessage('VoiceTarget', {
      targets: [{ session: cache.users }],
      id: cache.whisperId
    })
  })
})

if (WEB_PORT) {
  console.log('starting web server...')

  const fastify = server()
  fastify.register(websockets)

  let song

  fastify.get('/obs/:style', async (request, reply) => {
    const { style } = request.params

    reply.type('html')

    try {
      return render(`public/obs/${style}.pug`, {
        song
      })
    } catch {}

    return render('public/obs/plain.pug', {
      song
    })
  })

  fastify.get('/ws.js', async (request, reply) => {
    reply.type('application/javascript')
    return fs.readFile('public/ws.js')
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
