"""Shared pytest setup: Hypothesis settings profiles.

    pytest                                  # "ci" profile: quick, runs on every push
    HYPOTHESIS_PROFILE=thorough pytest      # many more examples; run before a release

A profile only changes how hard Hypothesis searches, never what the tests check.
"""

import os

from hypothesis import settings

# deadline=None: Hypothesis normally fails any example slower than 200 ms. Timing on a shared CI
# runner (or a laptop on battery) is noisy, and these tests check correctness, not speed, so a
# slow example must not count as a failure. print_blob=True prints a short string with any
# failure that replays it exactly (@reproduce_failure), so a CI-only failure can be rerun locally.
settings.register_profile(
    "ci",
    max_examples=100,  # 100 random scenarios per test (Hypothesis' default)
    stateful_step_count=50,  # up to 50 operations per scenario in the state machine
    deadline=None,
    print_blob=True,
)
settings.register_profile(
    "thorough",
    max_examples=5_000,
    stateful_step_count=100,
    deadline=None,
    print_blob=True,
)
settings.load_profile(os.environ.get("HYPOTHESIS_PROFILE", "ci"))
