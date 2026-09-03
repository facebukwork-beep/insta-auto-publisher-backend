V10 FAST DIRECT SAVE

Run:
  py -m pip install -r requirements.txt
  py run.py

Open:
  http://127.0.0.1:8787

Why faster:
- No final ZIP creation.
- Saves directly to your selected drive/folder.
- Range is split into parallel batches (1-4 workers).

Recommended:
- Start with workers=3.
- If Instagram rate limits/errors, use 2 or 1.
- Use a drive with lots of free space.
