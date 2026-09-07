// Keep the core's session directory stable across panel restarts.
// Older builds may already have moved it; retain compatibility without
// deleting either directory or creating a second session on fresh installs.
const fs = require('fs')
const path = require('path')
const legacy = path.join(__dirname, 'Suhail_Baileys')
const branded = path.join(__dirname, 'Safful_Baileys')
if (!fs.existsSync(legacy) && fs.existsSync(branded)) {
  fs.symlinkSync('Safful_Baileys', legacy, 'dir')
}
