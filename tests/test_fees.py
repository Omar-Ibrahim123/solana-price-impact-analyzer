import pytest

from impact_analyzer.fees import taker_fee_bps
from impact_analyzer.synthetic import synthetic_book


def test_phoenix_fee_comes_from_the_account():
    snap = synthetic_book("phoenix")
    snap.meta["taker_fee_bps"] = 5
    assert taker_fee_bps("phoenix", snap) == 5


def test_base_tier_fallbacks():
    assert taker_fee_bps("kraken") == 40
    assert taker_fee_bps("coinbase") == 120
    assert taker_fee_bps("jupiter:SolFi") == 0
    with pytest.raises(ValueError):
        taker_fee_bps("nowhere")
