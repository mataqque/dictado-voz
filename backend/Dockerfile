# Backend de dictado. Bookworm (glibc 2.36) porque `kitten` se monta desde el
# host y necesita glibc >= 2.34; Alpine (musl) no lo podría ejecutar.
FROM node:20-bookworm-slim

# wl-copy: último recurso de entrega (portapapeles).
RUN apt-get update \
	&& apt-get install -y --no-install-recommends wl-clipboard \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production && yarn cache clean
COPY server.js comandos.js destino.js voz.js ./

# uid 1000 = tu usuario: los sockets de kitty y Hyprland solo admiten a su dueño.
USER node
CMD ["node", "server.js"]
