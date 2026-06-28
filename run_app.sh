#!/usr/bin/env bash
cd ~/Desktop/local-ai-lab
source .venv/bin/activate
export HSA_OVERRIDE_GFX_VERSION=10.3.0
exec python app.py
