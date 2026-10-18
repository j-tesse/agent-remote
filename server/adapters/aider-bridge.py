"""agent-remote <-> aider bridge. Run with aider's OWN interpreter (see aider.ts).

Aider has no RPC mode, so this drives its scripting API: aider's real `main()`
builds the coder (so ~/.aider.conf.yml, .env, --model … all apply), then we
patch the few seams every interactive point goes through. Wire format is JSONL
on a private dup of fd 1; fd 1 itself is pointed at stderr so aider's own
prints (it echoes the stream to stdout) can never corrupt the protocol.

in:  prompt{text} abort set_mode{mode} ui_response{id,value?,cancelled?}
out: hello/coder{…} turn_start{text} turn_end reply_start{reflection?}
     delta{text} reply_end{applied,written,error,content} output{level,text}
     confirm{id,…} ask{id,…} queue_cleared fatal{error}

Deliberately dumb: block parsing, reasoning tags and all chat mapping live in
the TypeScript translator, where they're unit-tested.
"""

import json
import os
import queue
import sys
import threading
import traceback
import _thread

# --- protocol channel (before aider prints anything) ------------------------
_proto = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
os.dup2(2, 1)
sys.stdout = os.fdopen(1, "w", encoding="utf-8", buffering=1, closefd=False)
_lock = threading.Lock()


def emit(msg):
    line = json.dumps(msg, ensure_ascii=False)
    with _lock:
        _proto.write(line + "\n")
        _proto.flush()


from aider.coders import Coder  # noqa: E402
from aider.commands import SwitchCoder  # noqa: E402
from aider.io import InputOutput  # noqa: E402
from aider.main import main as aider_main  # noqa: E402
from aider.reasoning_tags import REASONING_TAG  # noqa: E402
from aider import __version__  # noqa: E402

# Commands that need a local TTY/desktop (editor, clipboard, mic, browser).
BLOCKED = {
    "/editor", "/edit", "/voice", "/paste", "/copy", "/copy-context",
    "/multiline-mode", "/vim", "/report",
}
MODES = ("code", "ask", "architect")

inbox = queue.Queue()  # prompt / set_mode, consumed between turns
responses = {}  # card id -> response dict
responses_cv = threading.Condition()
state = {"busy": False, "card": 0}


def reader():
    for raw in sys.stdin:
        try:
            msg = json.loads(raw)
        except ValueError:
            continue
        kind = msg.get("type")
        if kind == "abort":
            # Drop queued prompts too: Stop means stop.
            drained = False
            while True:
                try:
                    inbox.get_nowait()
                    drained = True
                except queue.Empty:
                    break
            if drained:
                emit({"type": "queue_cleared"})
            if state["busy"]:
                _thread.interrupt_main()
        elif kind == "ui_response":
            with responses_cv:
                responses[msg.get("id")] = msg
                responses_cv.notify_all()
        elif kind in ("prompt", "set_mode"):
            inbox.put(msg)
    inbox.put(None)  # stdin closed → exit


def await_response(card_id):
    # Polled, not a bare wait(): KeyboardInterrupt from interrupt_main is only
    # delivered when the main thread runs bytecode.
    with responses_cv:
        while card_id not in responses:
            responses_cv.wait(0.1)
        return responses.pop(card_id)


def next_card_id():
    state["card"] += 1
    return f"aider-{state['card']}"


# --- io patches -------------------------------------------------------------


def confirm_ask(self, question, default="y", subject=None, explicit_yes_required=False,
                group=None, allow_never=False):
    self.num_user_asks += 1
    question_id = (question, subject)
    if question_id in self.never_prompts:
        return False
    if group and not group.show_group:
        group = None
    if group:
        allow_never = True
    if group and group.preference:
        res = group.preference[0]
    else:
        card_id = next_card_id()
        emit({
            "type": "confirm",
            "id": card_id,
            "question": question,
            "subject": subject,
            "group": bool(group),
            "explicitYes": bool(explicit_yes_required),
            "allowNever": bool(allow_never),
        })
        resp = await_response(card_id)
        res = "n" if resp.get("cancelled") else (resp.get("value") or "n")[0].lower()
    if res == "d" and allow_never:
        self.never_prompts.add(question_id)
        return False
    is_yes = res == "y" if explicit_yes_required else res in ("y", "a")
    if group:
        if res == "a" and not explicit_yes_required:
            group.preference = "all"
        elif res == "s":
            group.preference = "skip"
    self.append_chat_history(f"{question.strip()} {res}", linebreak=True, blockquote=True)
    return is_yes


def prompt_ask(self, question, default="", subject=None):
    self.num_user_asks += 1
    card_id = next_card_id()
    emit({"type": "ask", "id": card_id, "question": question, "default": default,
          "subject": subject})
    resp = await_response(card_id)
    res = default if resp.get("cancelled") else (resp.get("value") or default)
    self.append_chat_history(f"{question.strip()} {res.strip()}", linebreak=True,
                             blockquote=True)
    return res


def offer_url(self, url, prompt="Open URL for more info?", allow_never=True):
    # The browser is on another machine; never webbrowser.open() on the server.
    emit({"type": "output", "level": "info", "text": url})
    return False


_orig_tool_output = InputOutput.tool_output
_orig_tool_error = InputOutput.tool_error
_orig_tool_warning = InputOutput.tool_warning
_orig_write_text = InputOutput.write_text


def tool_output(self, *messages, log_only=False, bold=False):
    _orig_tool_output(self, *messages, log_only=log_only, bold=bold)
    text = " ".join(str(m) for m in messages)
    if not log_only and text.strip():
        emit({"type": "output", "level": "info", "text": text})


def tool_error(self, message="", strip=True):
    _orig_tool_error(self, message, strip=strip)
    if str(message).strip():
        emit({"type": "output", "level": "error", "text": str(message)})


def tool_warning(self, message="", strip=True):
    _orig_tool_warning(self, message, strip=strip)
    if str(message).strip():
        emit({"type": "output", "level": "warning", "text": str(message)})


written = []  # abs paths written by the current apply_updates


def write_text(self, filename, content, *args, **kwargs):
    res = _orig_write_text(self, filename, content, *args, **kwargs)
    written.append(str(filename))
    return res


InputOutput.confirm_ask = confirm_ask
InputOutput.prompt_ask = prompt_ask
InputOutput.offer_url = offer_url
InputOutput.tool_output = tool_output
InputOutput.tool_error = tool_error
InputOutput.tool_warning = tool_warning
InputOutput.write_text = write_text
InputOutput.ring_bell = lambda self: None

# --- coder patches ----------------------------------------------------------

# A second Ctrl-C within 2s makes aider sys.exit(); Stop must never kill it.
Coder.keyboard_interrupt = lambda self: None

_orig_send_message = Coder.send_message
_orig_apply_updates = Coder.apply_updates


def send_message(self, inp):
    # Class-level, so nested coders (architect's editor, /ask) stream too. A
    # repeat send on the same coder within a turn is aider reflecting (failed
    # edit, added files, lint) — surfaced so the transcript explains the retry.
    sends = getattr(self, "_ar_sends", 0)
    self._ar_sends = sends + 1
    self._ar_apply = None
    emit({"type": "reply_start", **({"reflection": inp} if sends else {})})
    streamed = False
    try:
        for chunk in _orig_send_message(self, inp):
            if chunk:
                streamed = True
                emit({"type": "delta", "text": chunk})
            yield chunk
    finally:
        apply = self._ar_apply
        emit({
            "type": "reply_end",
            "applied": apply is not None,
            "written": apply["written"] if apply else [],
            "error": apply["error"] if apply else None,
            # Non-streaming models yield nothing; the translator parses this.
            "content": None if streamed else (self.partial_response_content or ""),
        })


def apply_updates(self):
    written.clear()
    before = self.reflected_message
    edited = _orig_apply_updates(self)
    error = self.reflected_message if self.reflected_message != before else None
    self._ar_apply = {
        "written": sorted({self.get_rel_fname(p) for p in written}),
        "error": error,
    }
    return edited


Coder.send_message = send_message
Coder.apply_updates = apply_updates

# --- session ----------------------------------------------------------------


def mode_of(coder):
    ef = coder.edit_format
    return ef if ef in ("ask", "architect", "context", "help") else "code"


def describe(coder, kind):
    commands = []
    for name in sorted(coder.commands.get_commands()):
        if name in BLOCKED:
            continue
        fn = getattr(coder.commands, "cmd_" + name[1:].replace("-", "_"), None)
        doc = (fn.__doc__ or "").strip().splitlines()
        commands.append({"name": name[1:], "description": doc[0] if doc else ""})
    return {
        "type": kind,
        "version": __version__,
        "model": coder.main_model.name,
        "editFormat": coder.edit_format,
        "mode": mode_of(coder),
        "modes": list(MODES),
        "reasoningTags": sorted({REASONING_TAG, coder.reasoning_tag_name}),
        "commands": commands,
        "announcements": coder.get_announcements(),
    }


def switch(coder, kwargs, code_format):
    kwargs = dict(kwargs)
    announce = kwargs.pop("show_announcements", True) is not False
    # `/chat-mode code` (and a model switch onto its default) resets to the
    # model's own edit format; keep the one this harness was configured with.
    main_model = kwargs.get("main_model", coder.main_model)
    if kwargs.get("edit_format") == main_model.edit_format and kwargs[
        "edit_format"
    ] not in ("ask", "architect", "context", "help"):
        kwargs["edit_format"] = code_format
    new = Coder.create(io=coder.io, from_coder=coder, **kwargs)
    msg = describe(new, "coder")
    if not announce:
        msg["announcements"] = []
    emit(msg)
    return new


def run_turn(coder, text, code_format):
    emit({"type": "turn_start", "text": text})
    state["busy"] = True
    try:
        first = text.split(maxsplit=1)[0] if text.strip() else ""
        if first in BLOCKED:
            emit({"type": "output", "level": "error",
                  "text": f"{first} needs a local terminal; not available here."})
            return coder
        coder._ar_sends = 0
        coder.io.user_input(text)
        coder.run_one(text, preproc=True)
    except KeyboardInterrupt:
        emit({"type": "output", "level": "warning", "text": "Interrupted."})
    except SwitchCoder as sw:
        coder = switch(coder, sw.kwargs, code_format)
    except Exception as err:  # keep the session alive on any aider bug
        traceback.print_exc()
        emit({"type": "output", "level": "error", "text": f"{type(err).__name__}: {err}"})
    finally:
        state["busy"] = False
        emit({"type": "turn_end"})
    return coder


def main():
    threading.Thread(target=reader, daemon=True).start()
    try:
        coder = aider_main(sys.argv[1:], return_coder=True)
    except SystemExit as err:
        emit({"type": "fatal", "error": f"aider exited during startup ({err.code})"})
        return 1
    except Exception as err:
        traceback.print_exc()
        emit({"type": "fatal", "error": f"{type(err).__name__}: {err}"})
        return 1
    if not isinstance(coder, Coder):
        emit({"type": "fatal", "error": "aider failed to start (see stderr)"})
        return 1
    code_format = coder.edit_format
    emit(describe(coder, "hello"))

    while True:
        try:
            msg = inbox.get(timeout=0.2)
        except queue.Empty:
            continue
        except KeyboardInterrupt:  # an abort racing the end of a turn
            continue
        if msg is None:
            return 0
        if msg["type"] == "prompt":
            coder = run_turn(coder, msg.get("text", ""), code_format)
        elif msg["type"] == "set_mode" and msg.get("mode") in MODES:
            mode = msg["mode"]
            try:
                coder = switch(coder, {
                    "edit_format": code_format if mode == "code" else mode,
                    "summarize_from_coder": mode not in ("code", "ask"),
                }, code_format)
            except KeyboardInterrupt:
                pass
            except Exception as err:
                emit({"type": "output", "level": "error", "text": str(err)})


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
