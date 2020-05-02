const p = document.querySelector('p')

const protocol = location.protocol === 'http:' ? 'ws:' : 'wss:'

const connect = () => {
  const ws = new WebSocket(`${protocol}//${location.host}`)

  ws.onmessage = ({ data }) => {
    const { title } = JSON.parse(data)
    p.textContent = title
  }

  ws.onclose = () => setTimeout(connect, 5000)
}

connect()
