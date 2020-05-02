const p = document.querySelector('p')

const connect = () => {
  const ws = new WebSocket(`wss://${location.hostname}`)

  ws.onmessage = ({ data }) => {
    const { title } = JSON.parse(data)
    p.textContent = title
  }

  ws.onclose = () => setTimeout(connect, 5000)
}

connect()
