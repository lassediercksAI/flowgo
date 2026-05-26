package main

import (
	"math/rand/v2"
	"path/filepath"
	"strings"
)

var nameAdjectives = []string{
	"agile", "amazing", "awesome", "blazing", "bold",
	"brave", "brilliant", "bright", "calm", "charming",
	"cheerful", "clever", "cosmic", "crisp", "curious",
	"daring", "dazzling", "eager", "elegant", "epic",
	"fearless", "fierce", "friendly", "gentle", "graceful",
	"happy", "heroic", "humble", "jolly", "joyful",
	"keen", "kind", "lively", "loyal", "lucky",
	"magical", "mighty", "nimble", "noble", "playful",
	"quick", "radiant", "sharp", "snappy", "solid",
	"stellar", "swift", "vibrant", "witty", "zen",
}

var nameTechWords = []string{
	"api", "async", "binary", "blockchain", "browser",
	"buffer", "cache", "cli", "cloud", "cluster",
	"codec", "compiler", "container", "cookie", "cursor",
	"daemon", "database", "debugger", "docker", "firewall",
	"frontend", "gateway", "heap", "kernel", "lambda",
	"linker", "monorepo", "network", "packet", "parser",
	"pipeline", "pixel", "plugin", "protocol", "proxy",
	"queue", "regex", "router", "runtime", "schema",
	"sdk", "server", "shell", "socket", "stack",
	"syntax", "terminal", "thread", "token", "webhook",
}

func randomMapName() string {
	adj := nameAdjectives[rand.IntN(len(nameAdjectives))]
	tech := nameTechWords[rand.IntN(len(nameTechWords))]
	return adj + "_" + tech
}

func seedBoxLabel(path string) string {
	base := filepath.Base(path)
	return strings.TrimSuffix(base, ".flowgo")
}
