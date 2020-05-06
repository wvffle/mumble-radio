module.exports = {
  apps: [{
    name: 'radio.wvffle.net',
    script: 'pm2-start.js',
    node_args: '-r esm',
    watch: false
  }]
}
