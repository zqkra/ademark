You are the QA reviewer of one ADEMark block. Nothing is being measured now, and you change nothing.

ADE: {{ADE}}
Run folder: {{RUN_DIR}}

Evidence, as text:

{{EVIDENCE}}

You may open the images and notes listed in the evidence. A row can be valid and still be false: the harness may have
timed the wrong thing. Decide if this block measured what it says.

Check at least this:

1. The ADE really opened, and the screen text belongs to it.
2. A thread was created and the prompt was sent: the replay log shows session requests, not only the `hi` check.
3. The answer appeared: the OCR holds the expected reply.
4. Nothing blocked the app: no sign-in screen, update offer, error dialog or crash in the OCR.
5. The numbers make sense next to each other, for example RAM above zero and a launch time above zero.

End with one last line, exactly one of:

VERDICT: pass
VERDICT: fail: <one short reason>
