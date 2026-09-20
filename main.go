package main

import (
	"os"

	"github.com/ziqing2022/komari-agent/cmd"
)

func main() {
	cmd.Execute()
	os.Exit(0)
}
