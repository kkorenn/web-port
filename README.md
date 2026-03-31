# web-port

Open-source repo for [school.koren.rip](https://school.koren.rip).

This project is a private school game launcher that auto-detects playable web games in this repo and serves them through one portal UI.

## Disclaimer
Raldi's Crackhouse won't work due to one of the files being over 100mb, please clone the repo using this link:
```bash
git clone https://git.koren.rip/koren/school-arcade.git
```

## Launcher Features

- Auto-scan for playable `.html` entries across top-level game folders.
- Support for standalone single-file games in `html/`.
- Works on localhost, LAN, and remote tunnel/domain setups.
- Responsive game grid that adapts by browser width.
- In-page 16:9 game player with `Open in tab`, `Close`, and `Fullscreen`.
- Popup-resistant iframe sandbox for embedded games.
- Most Played tracking with backend play-count APIs.
- Optional Discord invite button and feedback webhook/inbox system.

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Start the launcher:

```bash
npm start
```

3. Open the portal:

- Local machine: `http://127.0.0.1:4173`
- Other devices on same LAN: `http://<your-lan-ip>:4173`

On macOS, your LAN IP is usually:

```bash
ipconfig getifaddr en0
```

Use `npm run dev` for watch mode.

## Recommended Repo Split (Avoid 100MB GitHub Limit)

If game assets are too large for GitHub (for example Unity `.data` files), keep launcher code and game content in separate repos:

- Repo A: `web-port-launcher` (this Node/portal code)
- Repo B: `web-port-games` (all heavy game folders/assets)

Then point the launcher to the game repo with `GAMES_ROOT`.

### Example Layout

```text
/srv/school-games/
  launcher/    <- this repo
  games/       <- heavy assets repo (private/self-hosted)
```

### Clone From Separate Hosting

```bash
mkdir -p /srv/school-games
cd /srv/school-games

# launcher repo
git clone https://git.koren.rip/<your-user>/web-port-launcher.git launcher

# heavy games repo
git clone https://git.koren.rip/<your-user>/web-port-games.git games

cd launcher
cp .env.example .env
echo "GAMES_ROOT=/srv/school-games/games" >> .env

npm install
npm start
```

The launcher will scan `/srv/school-games/games` instead of the launcher directory.

## Network Modes

- Default: binds to `0.0.0.0` (LAN-accessible).
- Local-only mode: set `LOCAL_ONLY=1`.
- Public hosting/tunnel: point your reverse proxy or Cloudflare Tunnel at `http://127.0.0.1:4173`.

## Self-Hosting Git With Gitea (Public `git.koren.rip`)

Use this if you want your own public Git host (including large game repos with Git LFS).

### 1. Start Gitea (Docker)

```bash
mkdir -p /srv/gitea/{data,config}

docker run -d \
  --name gitea \
  --restart always \
  -p 127.0.0.1:3333:3000 \
  -p 2223:22 \
  -v /srv/gitea/data:/data \
  -v /srv/gitea/config:/etc/gitea \
  -e USER_UID=$(id -u) \
  -e USER_GID=$(id -g) \
  gitea/gitea:latest
```

Open `http://<your-server-ip>:3333` for first-time setup.
Recommended installer values:

- `Server Domain`: `git.koren.rip`
- `Gitea Base URL`: `https://git.koren.rip/`
- `Gitea HTTP Listen Port`: `3000`
- `SSH Server Port`: `2223` (or disable SSH if using HTTPS-only clones)
- Database/path values: keep defaults

### 2. Route Domain Through Cloudflare Tunnel

`/etc/cloudflared/config.yml` should include:

```yaml
ingress:
  - hostname: git.koren.rip
    service: http://localhost:3333
  - service: http_status:404
```

Then restart:

```bash
sudo systemctl restart cloudflared
```

### 3. Create Repositories (CLI/API)

Create a personal access token in Gitea (`Settings -> Applications -> Generate Token`) with repo scope.

```bash
export GITEA_URL="https://git.koren.rip"
export GITEA_TOKEN="<paste-token>"

curl -sS -X POST \
  -H "Authorization: token $GITEA_TOKEN" \
  -H "Content-Type: application/json" \
  "$GITEA_URL/api/v1/user/repos" \
  -d '{"name":"web-port-launcher","private":false}'

curl -sS -X POST \
  -H "Authorization: token $GITEA_TOKEN" \
  -H "Content-Type: application/json" \
  "$GITEA_URL/api/v1/user/repos" \
  -d '{"name":"web-port-games","private":false}'
```

### 4. Push Existing Local Repos

```bash
# launcher repo
cd /path/to/web-port
git remote add gitea https://git.koren.rip/<your-user>/web-port-launcher.git
git push -u gitea main

# games repo (separate local folder/repo)
cd /path/to/web-port-games
git remote add gitea https://git.koren.rip/<your-user>/web-port-games.git
git push -u gitea main
```

### 5. Deploy By Cloning From Gitea

```bash
mkdir -p /srv/school-games
cd /srv/school-games
git clone https://git.koren.rip/<your-user>/web-port-launcher.git launcher
git clone https://git.koren.rip/<your-user>/web-port-games.git games
```

Set `GAMES_ROOT` in `launcher/.env` to the `games` path and run the launcher.

### 6. Safe Commit + Push (Avoid Large-File Mistakes)

When this repo is dirty, stage only what you mean to push:

```bash
cd /path/to/web-port
git restore --staged .
git add README.md .gitignore server.js portal/index.html
git commit -m "docs: update gitea hosting and repo split instructions"
git push gitea main
```

If your branch has other unrelated changes, add only the exact files you want in that commit.

## Environment Variables

Copy `.env.example` to `.env` and edit as needed.

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Bind interface |
| `PORT` | `4173` | HTTP port |
| `LOCAL_ONLY` | unset | Set to `1` to block non-loopback clients |
| `GAMES_ROOT` | repo root | Override game scan root |
| `MAX_SCAN_DEPTH` | `4` | Max recursive depth per game folder |
| `RESCAN_INTERVAL_MS` | `300000` | Auto-rescan throttle window |
| `DISCORD_INVITE_URL` | empty | Shows/hides top-right Discord button |
| `DISCORD_WEBHOOK_URL` | empty | Primary Discord feedback webhook |
| `CUSTOM_FEEDBACK_WEBHOOK_URL` | empty | Optional secondary/custom feedback endpoint |
| `FEEDBACK_MAX_LENGTH` | `1200` | Max feedback message length |
| `FEEDBACK_COOLDOWN_MS` | `20000` | Per-IP feedback cooldown |
| `FEEDBACK_HISTORY_LIMIT` | `500` | Local feedback history cap |

## Data Files

Runtime data is stored in `.portal-data/`:

- `play-stats.json` - per-game play counts + last played timestamp
- `feedback-log.ndjson` - local feedback log history
- `feedback-inbox.ndjson` - fallback inbox when no webhook is configured

## API Endpoints

- `GET /api/games` - list discovered games
- `GET /api/games?refresh=1` - force rescan and return games
- `POST /api/stats/play` - increment play count for a slug
- `GET /api/stats/most-played?limit=...` - top played games
- `GET /api/config` - launcher UI config (Discord/feedback flags)
- `POST /api/feedback` - submit feedback
- `GET /api/feedback/list` - read feedback log
- `DELETE /api/feedback/:id` - delete one feedback entry
- `DELETE /api/feedback` - clear feedback history
- `GET /api/feedback/stream` - SSE live feedback stream

## Icons

- Folder game icon path: `<game-folder>/icon.png`
- Standalone `html` icon path: `html/icons/<generated-slug>.png`
- Recommended format: square `1:1` PNG.

## Full Game List + Credits

### Repo Folder Ports

- [Amanda The Adventurer](https://github.com/genizy/web-port/tree/main/amanda-the-adventurer) - Ported by [genizy](https://github.com/genizy)
- [Andy's Apple Farm](https://github.com/genizy/web-port/tree/main/andys-apple-farm) - Ported by [genizy](https://github.com/genizy)
- [Baldi's Basics Classic Remastered](https://github.com/genizy/web-port/tree/main/baldi-remaster) - Ported by [koi/_flixel](https://oldgrounds.xyz/)
- [Baldi's Basics Plus](https://github.com/genizy/web-port/tree/main/baldi-plus) - Ported by [koi/_flixel](https://oldgrounds.xyz/)
- [Bendy and The Ink Machine](https://github.com/genizy/web-port/tree/main/bendy) - Ported by [98Corbins](https://98cornbin.netlify.app)
- [BERGENTRUCK 201x](https://github.com/genizy/web-port/tree/main/bergentruck) - Ported by [genizy](https://github.com/genizy)
- [BLOODMONEY!](https://github.com/genizy/web-port/tree/main/bloodmoney) - Ported by [genizy](https://github.com/genizy)
- [Buckshot Roulette](https://github.com/genizy/web-port/tree/main/buckshot-roulette) - Ported by [genizy](https://github.com/genizy)
- [Class of '09](https://github.com/genizy/web-port/tree/main/class-of-09) - Ported by [genizy](https://github.com/genizy)
- [Dead Plate](https://github.com/genizy/web-port/tree/main/dead-plate) - Ported by [genizy](https://github.com/genizy)
- [Deadseat](https://github.com/genizy/web-port/tree/main/deadseat) - Ported by [slqnt](https://github.com/slqntdevss)
- [Deltatraveler](https://github.com/genizy/web-port/tree/main/deltatraveler) - Port credit currently untracked in this repo
- [Do NOT Take This Cat Home](https://github.com/genizy/web-port/tree/main/donottakethiscathome) - Ported by [genizy](https://github.com/genizy)
- [Fears to Fathom: Home Alone](https://github.com/genizy/web-port/tree/main/fears-to-fathom) - Ported by [slqnt](https://github.com/slqntdevss)
- [Getting Over It](https://github.com/genizy/web-port/tree/main/getting-over-it) - Port credit currently untracked in this repo
- [Happy Sheepies](https://github.com/genizy/web-port/tree/main/happy-sheepies) - Ported by [genizy](https://github.com/genizy)
- [Hotline Miami](https://github.com/genizy/web-port/tree/main/hotline-miami) - Ported by [98Corbins](https://98cornbin.netlify.app)
- [Human Expenditure Program](https://github.com/genizy/web-port/tree/main/human-expenditure-program) - Port credit currently untracked in this repo
- [Jelly Drift](https://github.com/genizy/web-port/tree/main/jelly-drift) - Port credit currently untracked in this repo
- [Karlson](https://github.com/genizy/web-port/tree/main/karlson) - Port credit currently untracked in this repo
- [Kindergarten 1 & 2](https://github.com/genizy/web-port/tree/main/kindergarten) - Ported by [genizy](https://github.com/genizy)
- [Lacy's Flash Games](https://github.com/genizy/web-port/tree/main/lacy-s-flash-games) - Ported by [genizy](https://github.com/genizy)
- [Milkman Karlson](https://github.com/genizy/web-port/tree/main/milkman-karlson) - Ported by [bog/aukak](https://github.com/aukak)
- [Minesweeperplus](https://github.com/genizy/web-port/tree/main/minesweeperplus) - Port credit currently untracked in this repo
- [OMORI](https://github.com/genizy/web-port/tree/main/omori) - Ported by [genizy](https://github.com/genizy)
- [People Playground](https://github.com/genizy/web-port/tree/main/people-playground) - Ported by [98Corbins](https://98cornbin.netlify.app)
- [Pizza Tower](https://github.com/genizy/web-port/tree/main/pizza-tower) - Ported by [burnedpopcorn](https://github.com/burnedpopcorn)
- [RAFT](https://github.com/genizy/web-port/tree/main/raft) - Ported by Ashen Arrow
- [R.E.P.O](https://github.com/genizy/web-port/tree/main/repo) - Ported by [98Corbins](https://98cornbin.netlify.app)
- [Raldi's Crackhouse](https://github.com/kkorenn/school-arcade/tree/main/raldi-s-crackhouse) - Ported by [me](https://github.com/kkorenn)
- [Schoolboy Runaway](https://github.com/genizy/web-port/tree/main/schoolboy-runaway) - Port credit currently untracked in this repo
- [Slender: The Eight Pages](https://github.com/genizy/web-port/tree/main/slender) - Ported by [genizy](https://github.com/genizy)
- [Sonic.Exe](https://github.com/genizy/web-port/tree/main/sonic.exe) - Port credit currently untracked in this repo
- [Speed Stars](https://github.com/genizy/web-port/tree/main/speed-stars) - Ported by [98Corbins](https://98cornbin.netlify.app)
- [Tattletail](https://github.com/genizy/web-port/tree/main/tattletail) - Port credit currently untracked in this repo
- [That's Not My Neighbor](https://github.com/genizy/web-port/tree/main/thats-not-my-neighbor) - Ported by [genizy](https://github.com/genizy)
- [The Man From the Window](https://github.com/genizy/web-port/tree/main/the-man-in-the-window) - Ported by [genizy](https://github.com/genizy)
- [Ultrakill](https://github.com/genizy/web-port/tree/main/ultrakill) - Ported by [98Corbins](https://98cornbin.netlify.app)
- [Undertale Yellow](https://github.com/genizy/web-port/tree/main/undertale-yellow) - Ported by [burnedpopcorn](https://github.com/burnedpopcorn)
- [Web Fishing](https://github.com/genizy/web-port/tree/main/web-fishing) - Ported by [genizy](https://github.com/genizy)
- [Witch Heart](https://github.com/genizy/web-port/tree/main/witch-heart) - Port credit currently untracked in this repo
- [Yandere Simulator](https://github.com/genizy/web-port/tree/main/yandere-simulator) - Port credit currently untracked in this repo
- [Yume Nikki](https://github.com/genizy/web-port/tree/main/yume-nikki) - Ported by [genizy](https://github.com/genizy)

### Standalone HTML Games (`html/`)

- 1v1 LoL (`html/1v1.LoL.html`) 
- A Dance of Fire and Ice (`html/A Dance of Fire and Ice.html`)
- A Difficult Game About Climbing (`html/A Difficult Game About Climbing.html`)
- Bad Parenting 1 (`html/Bad Parenting 1.html`)
- Baldi's Basics (`html/Baldi's Basics.html`)
- Brotato (`html/Brotato.html`)
- Celeste (`html/Celeste.html`)
- Chat Bot AI (A.I GPT) (`html/Chat Bot AI (A.I GPT).html`)
- Five Nights at Epstein's (`html/Five Nights at Epstein's.html`)
- Half Life (`html/Half Life.html`)
- Hollow Knight: Silksong (`html/Hollow Knight_ Silksong.html`)
- Jeffrey Epstein Basics In Education And Kidnapping (`html/Jeffrey Epstein Basics In Education And Kidnapping.html`)
- Minecraft 1.12.2 (`html/Minecraft 1.12.2.html`)
- Minecraft 1.8.8 (`html/Minecraft 1.8.8.html`)
- Sandstone Proxy (`html/Sandstone Proxy.html`)
- Soundboard (`html/Soundboard.html`)
- Terraria (`html/Terraria.html`)

## Credits

Thanks to everyone who made or shared these ports:

- [98Corbins](https://98cornbin.netlify.app)
- [bog/aukak](https://github.com/aukak)
- [burnedpopcorn](https://github.com/burnedpopcorn)
- [irv77](https://github.com/irv77)
- [koi/_flixel](https://oldgrounds.xyz/)
- [slqnt](https://github.com/slqntdevss)
- [SpanishFreddy](https://github.com/spanishfreddy)

If any game credit is missing or incorrect, open an issue or PR and it will be updated.

Have fun.
