#!/usr/bin/env bash
export PATH="/home/gron/.nvm/versions/node/v24.11.0/bin:$PATH"
export HSA_OVERRIDE_GFX_VERSION=10.3.0
cd /home/gron/Desktop/local-ai-lab/web
exec "/home/gron/.nvm/versions/node/v24.11.0/bin/node" ./node_modules/next/dist/bin/next start -p 8770
