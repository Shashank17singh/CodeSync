# Sandbox security results

Runtime: runc

| Attack | Goal | Status | Time (ms) | Contained |
| --- | --- | --- | --- | --- |
| fork bomb | Create processes until the host runs out | OK | 2078 | Yes |
| shell fork bomb | Classic :(){ :|:& };: bomb | OK | 215 | Yes |
| infinite loop | Hold a CPU forever | TIME_LIMIT_EXCEEDED | 5052 | Yes |
| memory bomb | Allocate until the host runs out | MEMORY_LIMIT_EXCEEDED | 202 | Yes |
| memory bomb in C++ | Allocate from native code | MEMORY_LIMIT_EXCEEDED | 176 | Yes |
| large file | Fill the disk | OK | 116 | Yes |
| root filesystem write | Change files outside /tmp | OK | 56 | Yes |
| network access | Reach the internet, cloud metadata or the Docker bridge | OK | 2196 | Yes |
| read /etc/shadow | Read password hashes | OK | 55 | Yes |
| /proc escape | Reach the host through /proc, /sys, mount, namespaces or setuid | OK | 71 | Yes |
| long sleep | Hold a sandbox past the time limit | TIME_LIMIT_EXCEEDED | 5049 | Yes |
| output flood | Exhaust worker memory with output | OUTPUT_LIMIT_EXCEEDED | 67 | Yes |
