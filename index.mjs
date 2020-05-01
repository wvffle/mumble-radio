import axios from 'axios'
import lame from 'lame'

// import Noodle from 'noodle.js'
import mumble from 'mumble'

import d3 from 'd3-array'
import ytdl from 'ytdl-core'
import ffmpeg from 'fluent-ffmpeg'
import dotenv from 'dotenv'
import { stringify as qs } from 'querystring'
import { createServer as http } from 'http'
import { EventEmitter } from 'events'
import websocket from 'websocket'
import { readFileSync as readFile } from 'fs'

dotenv.config()

const { server: WebSocket } = websocket

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

  stream.once('error', err => {
    console.error('[YTDL]', err)
    stream.emit('end')
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

  return new Promise((resolve) => {
    stream.on('info', (_, { audioChannels, audioBitrate }) => {
      ffmpegStream.channels = audioChannels
      ffmpegStream.sampleRate = audioBitrate

      resolve(ffmpegStream)
    })
  })
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
    nextSong(client)
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
  nextSong(client, voice)
})

if (WEB_PORT) {
  console.log('starting web server...')

  let song

  const server = http((_, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/html'
    })

    response.end(`<!DOCTYPE html>
        <html>
          <head>
            <meta charset='utf-8'>
              <style>
                body { font-family: JetBrains Mono, sans; font-size: 16px; color: #fff; margin: 0 }
                p { background: linear-gradient(0, #0005, #0000 90%); line-height: 100px; margin: 0; padding-left: 100px; text-shadow: 3px 3px 3px #0005; transition: opacity .2s ease }
              </style>
          </head>
          <body>
            <p>${song}</p>
            <script>
              const ws = new WebSocket('ws://localhost:${WEB_PORT}')
              const p = document.querySelector('p')

              ws.onmessage = ({ data: song }) => {
                p.textContent = song
                p.style.opacity = 1

                setTimeout(() => {
                  p.style.opacity = 0
                }, 2000)
              }
            </script>
          </body>
        </html>
      `)
  })

  const websocketServer = new WebSocket({
    httpServer: server
  })

  const clients = new Set()
  websocketServer.on('request', request => {
    const conn = request.accept(null, request.origin)
    clients.add(conn)

    if (song) {
      conn.sendUTF(song)
    }

    conn.on('close', () => {
      clients.remove(conn)
    })
  })

  bridge.on('song', title => {
    song = title

    for (const client of clients) {
      client.sendUTF(title)
    }
  })

  server.listen(WEB_PORT)
}
