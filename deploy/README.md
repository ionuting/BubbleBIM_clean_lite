# Deploy BubbleBIM Clean pe Hetzner (server dedicat)

| | |
|---|---|
| Server | `YOUR_SERVER_IP` |
| URL | `https://bbim.ciuntucbimstudio.ro` |
| App | **Clean** (`dist-clean-lite`) + auth JWT |
| Port | `3458` |

## Auth

| Rol | Sursă |
|---|---|
| Admin | setat prin `ADMIN_USERNAME`/`ADMIN_PASSWORD` în `deploy/.env` (obligatoriu — vezi `deploy/.env.example`) |
| User | Register din UI sau creat de admin |

Flux: **Login → Projects (doar ale tale) → Clean editor**

Admin: tab Users + All projects.

## Redeploy

```bash
./deploy/deploy.sh
```


## 0. Acces SSH (prima dată)

Pe Mac, adaugă cheia publică pe serverul nou (consolă Hetzner / Cloud → server → Console, sau `ssh-copy-id`):

```bash
ssh-copy-id root@YOUR_SERVER_IP
# test
ssh root@YOUR_SERVER_IP 'uname -a'
```

Pe server, instalează Docker (dacă lipsește):

```bash
ssh root@YOUR_SERVER_IP
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
```

## 1. Deploy aplicația

De pe Mac, din repo:

```bash
chmod +x deploy/deploy.sh deploy/setup-cloudflared.sh
./deploy/deploy.sh
```

Ce face:
1. `pnpm build:deploy` local
2. `rsync` → `/opt/bubblebim`
3. `docker compose up -d --build` (API Python + nginx cu `dist/`)

Test direct (port deschis pe firewall Hetzner):

```bash
curl -I http://YOUR_SERVER_IP:3458/
curl http://YOUR_SERVER_IP:3458/api/health
```

În Hetzner Cloud Firewall / Security Group: permite TCP **3458** doar dacă vrei acces direct; pentru Cloudflare Tunnel **nu e nevoie** de port public.

## 2. Mută subdomeniul pe serverul nou (Cloudflare Tunnel)

Hostname-ul `bubblebim.ciuntucbimstudio.ro` e acum pe tunelul **ollama-hetzner** (serverul vechi). Trebuie mutat pe un tunel de pe **YOUR_SERVER_IP**.

### A. Șterge ruta veche
Zero Trust → Networks → Tunnels → **ollama-hetzner** → Public Hostname  
→ șterge `bubblebim.ciuntucbimstudio.ro`

### B. Creează tunel nou
Zero Trust → Networks → Tunnels → **Create a tunnel**  
- Nume: `bubblebim-hetzner`  
- Connector: Cloudflared  
- Copiază **tokenul**

Public Hostname:

| Câmp | Valoare |
|---|---|
| Subdomain | `bubblebim` |
| Domain | `ciuntucbimstudio.ro` |
| Service | `http://127.0.0.1:3458` |

DNS CNAME se creează automat (sau se actualizează).

### C. Instalează connectorul pe server

```bash
BUBBLEBIM_TUNNEL_TOKEN="eyJ..." ./deploy/setup-cloudflared.sh
```

### D. Verifică

```bash
curl -I https://bubblebim.ciuntucbimstudio.ro
```

## 3. Redeploy ulterior

```bash
./deploy/deploy.sh
```

## Troubleshooting

| Simptom | Remediu |
|---|---|
| `Permission denied (publickey)` | `ssh-copy-id root@YOUR_SERVER_IP` |
| 502 pe HTTPS | App nu rulează pe `:3458` sau cloudflared nu e activ |
| Conflict DNS | Hostname încă pe tunelul `ollama-hetzner` — șterge-l de acolo |
| Docker missing | `curl -fsSL https://get.docker.com \| sh` |
