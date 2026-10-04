# Cast: scaffold a repo with `argus-reviewer init`.
# Recorded by `npm run demo:record` in a staged clean environment (see
# scripts/demo-record.mjs). No API key exists in that environment.
Output out/init.mp4

Set Shell "bash"
Set FontFamily "Martian Mono"
Set FontSize 15
Set LineHeight 1.25
Set Width 1100
Set Height 740
Set Padding 28
Set Framerate 25
Set TypingSpeed 40ms
Set CursorBlink false
Set Theme {"name":"Ocellus Dark","background":"#0C0E12","foreground":"#E8EBF0","cursor":"#7D91FF","selection":"#272C34","black":"#14171C","red":"#FF6E6A","green":"#3CCF94","yellow":"#F0B03C","blue":"#7D91FF","magenta":"#7D91FF","cyan":"#B4BBC6","white":"#B4BBC6","brightBlack":"#8A929E","brightRed":"#FF6E6A","brightGreen":"#3CCF94","brightYellow":"#F0B03C","brightBlue":"#7D91FF","brightMagenta":"#7D91FF","brightCyan":"#E8EBF0","brightWhite":"#E8EBF0"}

Hide
Type "source ./shell-profile.sh && cd my-app && clear"
Enter
Sleep 500ms
Show

Sleep 600ms
Type "argus-reviewer init"
Sleep 500ms
Enter
Sleep 6s
