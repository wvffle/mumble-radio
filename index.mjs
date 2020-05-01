import axios from 'axios'
import Noodle from 'noodle.js'
import d3 from 'd3-array'
import ytdl from 'ytdl-core'
import ffmpeg from 'fluent-ffmpeg'
import dotenv from 'dotenv'

dotenv.config()

const API_KEY = process.env.YOUTUBE_API_KEY
const PLAYLIST = process.env.PLAYLIST || 'PLl2JADJwpokG_bQWijyL6td759TiIhGhw'

const NAME = process.env.NAME || 'radio'
const HOST = process.env.HOST

const fetchPlaylist = async (pageToken = '') => {
  const { data: { nextPageToken, items } } = await axios.get(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${PLAYLIST}&pageToken=${pageToken}&key=${API_KEY}`)

  const snippets = items.map(({ snippet: { title, resourceId: { videoId: id } } }) => ({
    title, id
  }))

  if (nextPageToken) {
    return [ ...snippets, ...await fetchPlaylist(nextPageToken) ]
  }

  return snippets
}

const getAudioStream = (id) => {
  const stream = ytdl(id, {
    quality: 'highestaudio'
  })

  stream.once('error', err => {
    console.error('[YTDL]', err)
    stream.emit('end')
  })

  // Normalize audio volume
  return ffmpeg()
    .input(stream)
    .noVideo()
    .audioFilters('loudnorm')
    .format('mp3')
    .pipe()
}

const client = new Noodle({
  name: NAME,
  url: HOST
})

client.voiceConnection.on('error', err => {
  console.error('[VOICE]', err)
  client.voiceConnection.emit('end')
})

client.on('error', err => {
  console.error('[MUMBLE]', err)
  client.voiceConnection.emit('end')
})

const cache = {
  playlist: [],
  nextStream: null,
  nextItem: null
}

const fetchAndShuffle = async () => {
  try {
    const playlist = await fetchPlaylist()
    return [ ...cache.playlist, ...d3.shuffle(playlist) ]
  } catch (err) {
    console.error(err)
    await client.sendMessage(`Error fetching playlist: ${err}`)
  }
}

const nextSong = async () => {
  // Fetch if playlist is empty
  if (cache.playlist.length === 0) {
    cache.playlist = await fetchAndShuffle()
  }

  // Fetch stream if not fetched already
  if (cache.nextStream === null) {
    const curr = cache.playlist.pop()
    cache.nextStream = getAudioStream(curr.id)
    cache.nextItem = curr
  }

  const stream = cache.nextStream

  stream.once('error', err => {
    console.error('[FFMPEG]', err)
    client.voiceConnection.emit('end')
  })

  client.voiceConnection.playStream(stream)
  client.voiceConnection.once('end', nextSong)

  await client.sendMessage(cache.nextItem.title)
  console.log(cache.nextItem.title)

  // Fetch next stream
  cache.nextItem = cache.playlist.pop()
  cache.nextStream = getAudioStream(cache.nextItem.id)

  // Fetch if playlist has only 1 element
  if (cache.playlist.length === 1) {
    cache.playlist = await fetchAndShuffle()
  }
}

client.on('ready', async event => {
  nextSong()
})

client.connect()
