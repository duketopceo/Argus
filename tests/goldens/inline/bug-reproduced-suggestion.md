<!-- argus-reviewer:inline -->
◆ **bug** · ▰▰▰▰ reproduced
Loop bound `i <= len(events)` reads one past the end when `i == len(events)`. Use `<`.

````suggestion
for (let i = 0; i < events.length; i++) {
````

*Suggested change: review before committing.*

*Reproduced by an Argus probe: fails on this PR head, clean on base. See workflow artifacts.*