# Sandbox security results

Runtime: gVisor (runsc)

| Attack | Goal | Status | Time (ms) | Contained |
| --- | --- | --- | --- | --- |
| fork bomb | Create processes until the host runs out | RUNTIME_ERROR | 261 | Yes |
| shell fork bomb | Classic :(){ :|:& };: bomb | OK | 549 | Yes |
| infinite loop | Hold a CPU forever | TIME_LIMIT_EXCEEDED | 5056 | Yes |
| memory bomb | Allocate until the host runs out | MEMORY_LIMIT_EXCEEDED | 265 | Yes |
| memory bomb in C++ | Allocate from native code | MEMORY_LIMIT_EXCEEDED | 198 | Yes |
| large file | Fill the disk | OK | 190 | Yes |
| root filesystem write | Change files outside /tmp | OK | 58 | Yes |
| network access | Reach the internet, cloud metadata or the Docker bridge | OK | 2563 | Yes |
| read /etc/shadow | Read password hashes | OK | 64 | Yes |
| /proc escape | Reach the host through /proc, /sys, mount, namespaces or setuid | OK | 109 | Yes |
| long sleep | Hold a sandbox past the time limit | TIME_LIMIT_EXCEEDED | 5273 | Yes |
| output flood | Exhaust worker memory with output | OUTPUT_LIMIT_EXCEEDED | 77 | Yes |
