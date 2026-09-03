FROM node:20-alpine

# Install PostgreSQL client for backups (version 17 to match Supabase)
RUN apk add --no-cache postgresql17-client

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

RUN npm run build

# Create backup directory
RUN mkdir -p /backups

# No port needed - this is a worker that only runs cron jobs
# The API is now served by Cloudflare Pages

CMD ["node", "dist/worker.js"]
