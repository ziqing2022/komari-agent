package cmd

import (
	"fmt"
	"text/tabwriter"

	monitoring "github.com/ziqing2022/komari-agent/monitoring/unit"
	"github.com/spf13/cobra"
)

var CheckEnvCmd = &cobra.Command{
	Use:   "env",
	Short: "Check system virtualization and container/docker environment",
	Long:  `Check system virtualization, container runtime (Docker, Podman, LXC, K8s), container ID, and cgroup version.`,
	Run: func(cmd *cobra.Command, args []string) {
		w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 0, 2, ' ', 0)
		fmt.Fprintln(w, "Property\tValue")
		fmt.Fprintf(w, "Virtualization\t%s\n", monitoring.Virtualized())

		info := monitoring.GetContainerInfo()
		fmt.Fprintf(w, "Is Container\t%t\n", info.IsContainer)
		fmt.Fprintf(w, "Container Runtime\t%s\n", info.Runtime)
		if info.ContainerID != "" {
			fmt.Fprintf(w, "Container ID\t%s\n", info.ContainerID)
		}
		fmt.Fprintf(w, "Cgroup Version\t%s\n", info.CgroupVer)
		_ = w.Flush()
	},
}

func init() {
	RootCmd.AddCommand(CheckEnvCmd)
}
