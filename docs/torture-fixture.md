# Deploy postmortem

Short para with **bold**, *italic*, `inline code`, ~~strike~~, and a [link](https://example.org).

## Timeline

| Time | Event | Owner |
| --- | --- | --- |
| 09:12 | Alert fired | Jakub |
| 09:20 | Rolled back | on-call |

## Steps taken

1. Checked the queue table
2. Found dedup logic looping
   - nested bullet
   - second nested with `code`
3. Patched and redeployed

- [ ] Unchecked task
- [x] Checked task

> Blockquote with **bold** inside.
> Second line.

```python
def foo(x: int) -> str:
    return f"{x}"
```

Horizontal rule below.

---

Trailing para with a bare URL https://example.com and an ![image](https://example.com/a.png).
