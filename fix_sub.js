const fs = require('fs');
let c = fs.readFileSync('e:/git/rw2026-bestip/index.js', 'utf8');

// Fix 1: add scy and alpn to vmess, add ed=2560 to path
c = c.replace(
  "id: UUID, aid: '0', net: 'ws'",
  "id: UUID, aid: '0', scy: 'none', net: 'ws'"
);
c = c.replace(
  "path: '/vmess-argo', tls:",
  "path: '/vmess-argo?ed=2560', tls:"
);
c = c.replace(
  "sni: argoDomain, fp: 'firefox' }",
  "sni: argoDomain, alpn: '', fp: 'firefox' }"
);

// Fix 2: remove leading newline from allLinks
c = c.replace(
  "let allLinks = `\\n${vless}\\n${vmess}\\n${trojan}\\n`",
  "let allLinks = `${vless}\\n${vmess}\\n${trojan}`"
);

fs.writeFileSync('e:/git/rw2026-bestip/index.js', c);
console.log('Fixed!');
