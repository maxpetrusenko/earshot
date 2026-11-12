# Listen: the edited memo script

What earshot speaks into `listen.mp3` for the reply in [reply.md](reply.md). The
model writes it from the reply alone, in the shape the ear-script prompt asks
for: what got done, what changed for you, then the one thing you might need to
do.

**Title:** The invoice page now loads in one query

**Spoken script (83 words, 28 seconds):**

> The slow invoice page is fixed. It was fetching the invoice list, then asking
> the database for each customer name one at a time, two hundred and one queries
> for a page of two hundred invoices. Now they all come back in one joined
> query. On the staging copy the page went from one point eight seconds to two
> hundred and forty milliseconds. The join uses the customer index that was
> already there, so no migration is needed. Nothing is needed from you.

## Why it is shaped this way

- **Outcome first.** The first sentence says the page is fixed, because that is
  the part you would act on.
- **One number you can feel.** Two hundred and one queries and one point eight
  seconds are the two facts that explain the delay; the rest of the report's
  numbers stay in the chat.
- **Read aloud, not read.** "One point eight seconds" rather than "1.8 s", no
  file names, no SQL, no test count.
- **A closing decision.** There is nothing to decide, so it says so in one line
  instead of trailing off.

## What the Original track keeps

[original.txt](original.txt) is the agent's own wording, read as written. It
carries the details the memo drops: the staging copy, the customer index, the
fact that each query waited for the last one, and the test count. Listen to
`original.mp3` when you want to check the reasoning rather than the result.
