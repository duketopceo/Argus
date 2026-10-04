<!-- argus-reviewer:inline -->
◈ **risk** · ▰▰▱▱ corroborated
no retry on 429 from the pricing API. Wrap the call in `withBackoff(3)`.

*CI evidence: test check `unit (22)` failed on this head*