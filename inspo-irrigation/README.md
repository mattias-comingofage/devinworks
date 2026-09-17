# Inspo irrigation

Weekly harvest of stunt / art / ad references, scored against live briefs
(`briefs.yaml`) and paired with historical mechanisms (`canon.yaml`).

    pip install -r requirements.txt
    python irrigate.py --out out --lookback 10

Outputs: `digest.md`, `digest.html`, `digest.json` (strict, surfaced items)
and `candidates.json` (top-40 broad pool for human/LLM curation).
