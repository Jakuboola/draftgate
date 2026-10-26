---
name: setup
description: Choose which of your tools draftgate reviews, and check that the gate works. Run it after installing the draftgate plugin, and again after adding a connector.
allowed-tools: Bash(draftgate *), AskUserQuestion
disable-model-invocation: true
---

Set up draftgate in this session. draftgate holds the messages my tools send to Jira, Slack, Linear
and GitHub, and shows each one to me in a window before it goes.

The draftgate plugin already reviews every send tool draftgate knows, under any server name. So
nothing below turns the gate on: it narrows it to what I want reviewed, and covers tools of my own
the plugin cannot see. If we stop halfway, every tool it knows stays reviewed.

Rules:
1. Do not narrate. Ask the questions below in the words given, run the commands, and write nothing
   else: no step names, no summary of what a command printed, no "done". The last command prints
   what setup ends with.
2. Run only `draftgate` commands. Change nothing of Claude Code's yourself: no settings file, no
   hook. The one change to Claude Code's settings is `draftgate register` in step 4, and only after
   I say yes there.
3. If a command in steps 1 to 4 exits non-zero, show me what it printed, exactly, in a code block,
   and stop; step 5 says what to show for its command. A gate that looks installed and is not is
   worse than one that is obviously missing.

Steps:

1. Run:

       draftgate propose-tools --known

   It prints short tool names, one per line. Then run this with every MCP tool name you have that
   ends in `__` and one of them (`mcp__<server>__slack_send_message` for `slack_send_message`), and
   no other name. With none, run it with no names:

       draftgate propose-tools <name> <name> ...

   A name left out changes nothing about what is reviewed. It is only missing from the list I choose
   from below.

2. Ask me ONE question, with two options in this order: "Review everything (recommended)" and
   "Let me choose". Use AskUserQuestion if you have it, otherwise ask in plain text and wait.
   - Review everything: my answer declines nothing.
   - Let me choose: the CHOOSE list it printed puts the tools under plain headings, each starting
     with where it sends ("Jira: comments"). Ask about the headings one destination at a time, in
     the list's order, each in its own question and its own AskUserQuestion call: never two
     questions in one call. Wait for each answer before you ask the next.
     - A destination with two to four headings: "Which of these should draftgate review?", one
       option per heading, in the words the list prints, with multiSelect on. More than four:
       split them into questions of up to four, each its own call.
     - A destination with one heading: "Should draftgate review <the heading>?", with two options
       in this order: "Review it" and "Don't review it".
     - Check each answer before you go on. A question that came back with no answer, or with an
       answer that is not one of its options: ask it again. One that came back with nothing
       picked: ask me ONE question, "Don't review any of these: <its headings>?", with two options
       in this order: "Ask me again" and "Don't review them". Never take a missing or empty answer
       as a choice: only "Don't review it" and "Don't review them" decline a heading.

3. Record my answer. Do not repeat the names from step 1: draftgate kept them for this.

   For "Review everything":

       draftgate propose-tools --decline --write

   For "Let me choose", every heading in the CHOOSE list, under exactly one of the two flags:

       draftgate propose-tools --review <short name> ... --decline <short name> ... --write

   Give the SHORT names as the CHOOSE list prints them (`slack_send_message`, not
   `mcp__..._slack_send_message`): after --review every one under each heading I chose to review,
   after --decline every one under each heading I chose not to. If it says "the answer leaves these
   unanswered", ask me about the headings it lists as in step 2, then run it again with the whole answer.

4. Only if that output says "draftgate can't watch these by default", ask me ONE question, in these
   words: "draftgate can't watch these by default: <the tool names it lists>. Add them?", with two
   options in this order: "Add them (recommended)" and "Leave them unreviewed". If the output does
   not say it, skip this question.
   - Add them: run `draftgate register`. It writes one entry into Claude Code's settings that
     covers only those tools.
   - Leave them unreviewed: run nothing.

   Only if that output says "Claude Code's user settings hold a draftgate entry the plugin does not
   need", ask me ONE question, in these words: "Claude Code's settings still hold an old draftgate
   entry, which can open a second review window for every send, or stop reviewing my own tools
   after an update. Replace it?", with two options in
   this order: "Replace it (recommended)" and "Leave it". If the output does not say it, skip this
   question, and if you already ran `draftgate register` for "Add them", skip it too: that run
   replaced the old entry as well.
   - Replace it: run `draftgate register`. It also adds the entry for any tools that output listed
     under "can't watch these by default". If I chose "Leave them unreviewed" for those, first tell
     me in one line, in these words: "Replacing it reviews <those tool names> too."
   - Leave it: run nothing.

   Only if that output says "tools.json overrides draftgate's own entry for these", ask me ONE
   question per indented line it lists under that, in these words: "My tools.json entry for <the tool name>
   overrides draftgate's own: <the rest of the line>. Use draftgate's instead?", with two options
   in this order: "Use draftgate's" and "Keep mine". If the output does not say it, skip these
   questions.
   - Then, only if I chose "Use draftgate's" for any, run `draftgate propose-tools --drop` with
     the full tool name of each one I chose, space-separated.

5. Run:

       draftgate doctor --setup

   - Exit 0: it printed what setup ends with. Show it to me exactly as printed, in a code block,
     and add nothing before or after it.
   - Exit 1: it printed the doctor's report. Show me only its `PROBLEM:` paragraphs and its last
     line, exactly as printed, in a code block, and stop. If I chose "Leave them unreviewed" or
     "Leave it" in step 4, the report names what I chose to leave: then add one line after the
     block, "That is what you chose in setup."
