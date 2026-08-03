#!/usr/bin/env python3
"""Автоматический деплой Rave TMA на Render.com через API."""
import json
import urllib.request

API_KEY = "rnd_R66EZjUPO072LyuvFzdybXNHAChP"
OWNER_ID = "tea-d9o9v37lk1mc7385d38g"

payload = {
    "type": "web_service",
    "name": "rave-tma",
    "ownerId": OWNER_ID,
    "repo": "https://github.com/xanemd/rave-tma",
    "branch": "main",
    "autoDeploy": True,
    "plan": "free",
    "registryCredentials": [],
    "envVars": [],
    "envSpecificDetails": {
        "buildCommand": "",
        "startCommand": "npm start",
        "healthCheckPath": "/"
    }
}

req = urllib.request.Request(
    "https://api.render.com/v1/services",
    data=json.dumps(payload).encode("utf-8"),
    headers={
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json"
    },
    method="POST"
)

try:
    with urllib.request.urlopen(req) as resp:
        body = resp.read().decode("utf-8")
        print(f"STATUS: {resp.status}")
        print(body)
except urllib.error.HTTPError as e:
    body = e.read().decode("utf-8")
    print(f"HTTP ERROR: {e.code}")
    print(body)