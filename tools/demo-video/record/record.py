"""
Record a real Claude Code session in a pty as an asciicast v2 file, typing each prompt like a person.

python3 record.py <out.cast> <claude argv...>, with PROMPTS (a JSON list of {text, quiet, timeout})
and COLS/ROWS in the environment. `record.sh` is the one caller. Answers the folder-trust dialog
with "Yes" (it defaults to "No, exit"). A turn ends when output has been quiet for `quiet` seconds;
a review window holds the tool call open with the spinner still drawing, so it is not quiet.
"""
import codecs, json, os, pty, select, signal, struct, sys, termios, fcntl, time, random

COLS, ROWS = int(os.environ.get('COLS', 100)), int(os.environ.get('ROWS', 30))
out_path, argv = sys.argv[1], sys.argv[2:]
PROMPTS = json.loads(os.environ['PROMPTS'])
MAX = float(os.environ.get('MAX_SECONDS', 600))

pid, fd = pty.fork()
if pid == 0:
    os.environ.update(TERM='xterm-256color', COLORTERM='truecolor')
    os.execvp(argv[0], argv)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLS, 0, 0))
os.kill(pid, signal.SIGWINCH)

t0 = time.time()
cast = open(out_path, 'w')
cast.write(json.dumps({'version': 2, 'width': COLS, 'height': ROWS, 'timestamp': int(t0), 'env': {'TERM': 'xterm-256color'}}) + '\n')
screen = ''
last_out = time.time()
# A read can end inside a multi-byte character; the decoder holds the partial bytes for the next one.
decode = codecs.getincrementaldecoder('utf-8')('replace').decode

def pump(wait):
    global screen, last_out
    end = time.time() + wait
    while True:
        r, _, _ = select.select([fd], [], [], max(0, end - time.time()))
        if not r:
            return True
        try:
            data = os.read(fd, 65536)
        except OSError:
            return False
        if not data:
            return False
        s = decode(data)
        if not s:
            continue
        cast.write(json.dumps([round(time.time() - t0, 4), 'o', s]) + '\n'); cast.flush()
        screen = (screen + s)[-200000:]
        last_out = time.time()

def plain():
    import re
    return re.sub(r'\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b.', '', screen)

def idle(seconds, timeout):
    end = time.time() + timeout
    while time.time() < end:
        if not pump(0.3):
            return
        if time.time() - last_out > seconds:
            return

def type_text(text):
    for ch in text:
        os.write(fd, ch.encode())
        pump(random.uniform(0.04, 0.11))

# Startup: answer the folder-trust dialog if it appears, then wait for the input box.
idle(4, 30)
if 'trust' in plain().lower():
    os.write(fd, b'\x1b[B'); pump(0.5); os.write(fd, b'\r'); idle(4, 30)

for p in PROMPTS:
    screen = ''
    type_text(p['text'])
    pump(0.6)
    os.write(fd, b'\r')
    # A turn is over when output has been quiet this long. A review window is not quiet: the hook
    # holds the tool call open and the spinner keeps drawing until the reviewer decides.
    idle(p.get('quiet', 8), p.get('timeout', 300))
    if time.time() - t0 > MAX:
        break

pump(1.5)
os.write(fd, b'\x03'); pump(0.5); os.write(fd, b'\x03'); pump(1.5)
try: os.kill(pid, signal.SIGTERM)
except ProcessLookupError: pass
cast.close()
print('recorded', round(time.time() - t0, 1), 's ->', out_path)
