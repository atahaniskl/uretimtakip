"""
Planlama motorunun (app/core/date_utils.py) kanonik kurallarını kilitleyen testler.

NEDEN BU TESTLER VAR
--------------------
date_utils.py'deki yorumlar, bu kuralların her birinin geçmişte en az bir kez
sessizce bozulduğunu ve canlı veride yanlış üretim tarihlerine yol açtığını
belgeliyor ("...gerçek bir bug'dı", "canlı veriden doğrulandı"). Bu dosya o
davranışları donduruyor: aşağıdaki testlerden biri kırmızıya dönerse, planlama
matematiği değişmiş demektir — ekranda fark edilmeden önce burada yakalanır.

Testler MEVCUT (2026-07 itibarıyla üretimdeki) davranışı yakalar, "olması
gereken"i değil. Bir kural bilinçli olarak değiştirilirse ilgili test de
güncellenmeli; kaza eseri değişirse test bunu haber verir.

Tüm tarihler 2026 Ağustos'undan seçildi ve tatil kümesi boş tutuldu; böylece
yalnızca hafta sonu mantığı devrede olur ve testler resmi tatil verisinden
bağımsız kalır.

  2026-07-24 Cum | 07-25 Cmt | 07-26 Paz | 07-27 Pzt
  2026-08-07 Cum | 08-08 Cmt | 08-09 Paz | 08-10 Pzt
"""

from datetime import date, datetime

import pytest

from app.core.date_utils import (
    BLOCK_KEYS,
    _block_days,
    add_workdays,
    build_product_params,
    calculate_component_end_date,
    calculate_split_stage_ranges,
    calculate_split_start_date,
    effective_product_params,
    effective_split_quantity,
    is_outsourced_from_base_data,
    is_workday,
    subtract_workdays,
)

NO_HOLIDAYS: set[date] = set()
ONE_EMPLOYEE = {"assembly": 1.0, "production": 1.0, "test": 1.0}
WORK_MINUTES = 480.0  # 8 saat


def dt(iso_day: str) -> datetime:
    """'2026-08-07' -> datetime(2026, 8, 7, 0, 0)"""
    return datetime.fromisoformat(f"{iso_day}T00:00:00")


def blocks_by_key(blocks: list[dict]) -> dict[str, dict]:
    return {b["key"]: b for b in blocks}


# --- Temel iş günü aritmetiği -------------------------------------------------


class TestIsWorkday:
    def test_hafta_sonu_is_gunu_degildir(self):
        assert is_workday(date(2026, 7, 25), NO_HOLIDAYS) is False  # Cumartesi
        assert is_workday(date(2026, 7, 26), NO_HOLIDAYS) is False  # Pazar

    def test_hafta_ici_is_gunudur(self):
        assert is_workday(date(2026, 7, 24), NO_HOLIDAYS) is True  # Cuma
        assert is_workday(date(2026, 7, 27), NO_HOLIDAYS) is True  # Pazartesi

    def test_resmi_tatil_is_gunu_degildir(self):
        tatil = {date(2026, 7, 27)}  # Pazartesi'yi tatil ilan et
        assert is_workday(date(2026, 7, 27), tatil) is False


class TestSubtractWorkdays:
    def test_pazartesiden_bir_is_gunu_geri_cumaya_gider(self):
        assert subtract_workdays(dt("2026-07-27"), 1, NO_HOLIDAYS) == dt("2026-07-24")

    def test_cumartesiden_bir_is_gunu_geri_de_cumaya_gider(self):
        """`subtract_workdays` ÖNCE bir gün geriye gider, SONRA iş günü mü diye
        bakar ("decrement-first"). Bu sayede başlangıcın kendisi hafta sonuna
        denk gelse bile doğru sonuç üretir.

        date_utils.py:382-394'teki uyarının konusu tam olarak budur: çağıran
        tarafta ayrıca bir "en yakın iş gününe yuvarla" adımı eklenirse önceki
        iş günü İKİ KEZ atlanır ve start_date 1 iş günü erken hesaplanır."""
        assert subtract_workdays(dt("2026-07-25"), 1, NO_HOLIDAYS) == dt("2026-07-24")

    def test_sifir_veya_negatif_gun_baslangici_degistirmez(self):
        assert subtract_workdays(dt("2026-07-27"), 0, NO_HOLIDAYS) == dt("2026-07-27")
        assert subtract_workdays(dt("2026-07-27"), -3, NO_HOLIDAYS) == dt("2026-07-27")


class TestAddWorkdays:
    def test_bir_is_gunu_ileri_exclusive_bitis_dondurur(self):
        """Cuma'da 1 iş günü çalışılır, dönen değer o günün BİTİŞİ (Cumartesi 00:00).
        Yani sonuç bir iş gününe denk gelmek zorunda değildir — bu, BOM'daki
        `component_ready_at`'in neden geri yuvarlanması gerektiğinin sebebidir
        (bkz. TestBomZamanlama.test_component_ready_at_hafta_sonundan_geri_yuvarlanir)."""
        assert add_workdays(dt("2026-07-24"), 1, NO_HOLIDAYS) == dt("2026-07-25")

    def test_hafta_sonunu_atlar(self):
        # Cuma'dan 2 iş günü: Cuma + Pazartesi -> Salı 00:00
        assert add_workdays(dt("2026-07-24"), 2, NO_HOLIDAYS) == dt("2026-07-28")

    def test_sifir_gun_baslangici_degistirmez(self):
        assert add_workdays(dt("2026-07-27"), 0, NO_HOLIDAYS) == dt("2026-07-27")


# --- Blok süreleri (_block_days) ---------------------------------------------


class TestMinimumBirGunKurali:
    """Tedarik ve Teslimat, değer girilmemiş/0 olsa bile en az 1 gün sayılır.
    Gerekçe (date_utils.py:277-282, 330-335): aksi halde blok tamamen düşer ve
    yalnızca Teslimat aşamasına göre filtreleyen "Özet" takvimi gibi görünümlerde
    sipariş tamamen kaybolur."""

    @pytest.mark.parametrize("params", [{}, {"supply_days": 0}, {"supply_days": None}])
    def test_tedarik_en_az_bir_gun(self, params):
        assert _block_days("supply", params, 1, ONE_EMPLOYEE, WORK_MINUTES) == 1

    @pytest.mark.parametrize("params", [{}, {"delivery_days": 0}, {"delivery_days": None}])
    def test_teslimat_en_az_bir_gun(self, params):
        assert _block_days("delivery", params, 1, ONE_EMPLOYEE, WORK_MINUTES) == 1

    def test_gun_modunda_bos_uretim_ve_test_de_en_az_bir_gun(self):
        assert _block_days("production", {}, 1, ONE_EMPLOYEE, WORK_MINUTES) == 1
        assert _block_days("test", {}, 1, ONE_EMPLOYEE, WORK_MINUTES) == 1


class TestDurationMode:
    def test_mod_belirtilmemisse_flat_kabul_edilir(self):
        """duration_mode=None -> "flat" (İş Günü). Yalnızca kullanıcı açıkça
        'per_unit' seçtiyse adet çarpımı devreye girer (date_utils.py:275)."""
        params = {"assembly_flat_days": 5, "assembly_days": 2}
        # flat dalı: assembly_flat_days kullanılır, adet çarpılmaz
        assert _block_days("assembly", params, 100, ONE_EMPLOYEE, WORK_MINUTES) == 5
        assert (
            _block_days("assembly", {**params, "duration_mode": "flat"}, 100, ONE_EMPLOYEE, WORK_MINUTES) == 5
        )

    def test_per_unit_modunda_adetle_carpilir(self):
        params = {"assembly_days": 2, "duration_mode": "per_unit"}
        assert _block_days("assembly", params, 10, ONE_EMPLOYEE, WORK_MINUTES) == 20

    def test_per_unit_modunda_isci_sayisina_bolunur(self):
        params = {"assembly_days": 2, "duration_mode": "per_unit"}
        iki_isci = {"assembly": 2.0, "production": 1.0, "test": 1.0}
        assert _block_days("assembly", params, 10, iki_isci, WORK_MINUTES) == 10

    def test_flat_modunda_isci_sayisi_sureyi_degistirmez(self):
        """Gün modunda kullanıcının yazdığı gün sayısı KESİNDİR — kaç işçi
        atanırsa atansın süre değişmez (date_utils.py:268-274). İşçiler yine de
        kapasite/çakışma hesabına dahil edilir, sadece SÜREYİ belirlemezler."""
        params = {"assembly_flat_days": 5, "duration_mode": "flat"}
        dort_isci = {"assembly": 4.0, "production": 1.0, "test": 1.0}
        assert _block_days("assembly", params, 100, ONE_EMPLOYEE, WORK_MINUTES) == 5
        assert _block_days("assembly", params, 100, dort_isci, WORK_MINUTES) == 5

    def test_flat_modunda_alan_bossa_per_unit_esdegerine_duser(self):
        """Gün modunda "toplam gün" alanı boşsa, kullanıcının Adet Başına
        tarafında zaten girdiği veri boşa gitmesin diye oradan hesaplanan
        eşdeğer gün sayısı kullanılır (date_utils.py:298-303)."""
        params = {"assembly_days": 2}  # assembly_flat_days YOK, mod None (=flat)
        assert _block_days("assembly", params, 10, ONE_EMPLOYEE, WORK_MINUTES) == 20


class TestDakikaBazliHesap:
    def test_uretim_dakikalari_toplanip_tek_seferde_yukari_yuvarlanir(self):
        """Alt alanlar ÖNCE toplanır, SONRA tek seferde ceil edilir. Her alanı
        ayrı ayrı ceil edip toplamak farklı (daha uzun) sonuç verir — bu sapma
        geçmişte BOM'lu ürünlerde haftalarca boşluğa yol açmıştı
        (bkz. deliveryPlanMath.ts:4-8)."""
        params = {"duration_mode": "per_unit", "epoxy_minutes": 60, "montaj_minutes": 60}
        # (60+60) * 8 adet / (480 dk * 1 isci) = 2 gun
        assert _block_days("production", params, 8, ONE_EMPLOYEE, WORK_MINUTES) == 2

    def test_uretim_isci_sayisina_bolunur(self):
        params = {"duration_mode": "per_unit", "epoxy_minutes": 60, "montaj_minutes": 60}
        iki_isci = {"assembly": 1.0, "production": 2.0, "test": 1.0}
        assert _block_days("production", params, 8, iki_isci, WORK_MINUTES) == 1

    def test_test_dakikalari_ayri_grupta_toplanir(self):
        params = {
            "duration_mode": "per_unit",
            "test1_minutes": 240,
            "test2_minutes": 240,
        }
        # (240+240) * 1 / 480 = 1 gun
        assert _block_days("test", params, 1, ONE_EMPLOYEE, WORK_MINUTES) == 1


class TestFason:
    """Fason (dış dizgi): iş dışarıda yapılır, iş yükü hesaplanmaz — kullanıcının
    Dizgi alanına girdiği gün sayısı DOĞRUDAN kullanılır: adetle çarpılmaz, işçi
    sayısına bölünmez, moddan bağımsızdır (date_utils.py:285-293)."""

    def test_adetle_carpilmaz_ve_isciye_bolunmez(self):
        params = {"assembly_days": 3}
        bes_isci = {"assembly": 5.0, "production": 1.0, "test": 1.0}
        assert _block_days("assembly", params, 100, bes_isci, WORK_MINUTES, is_outsourced=True) == 3

    def test_moddan_bagimsizdir(self):
        for mode in (None, "flat", "per_unit"):
            params = {"assembly_days": 3, "duration_mode": mode}
            assert (
                _block_days("assembly", params, 50, ONE_EMPLOYEE, WORK_MINUTES, is_outsourced=True) == 3
            ), f"mod={mode}"

    def test_bos_birakilirsa_en_az_bir_gun(self):
        assert _block_days("assembly", {}, 100, ONE_EMPLOYEE, WORK_MINUTES, is_outsourced=True) == 1


# --- Aşama yerleşimi (calculate_split_stage_ranges) --------------------------


BASIC_PARAMS = {
    "supply_days": 2,
    "delivery_days": 1,
    "duration_mode": "flat",
    "assembly_flat_days": 2,
    "production_flat_days": 2,
    "test_flat_days": 1,
}


class TestAsamaYerlesimi:
    def test_bloklar_kanonik_sirada_ve_bitisik_dondurulur(self):
        blocks = calculate_split_stage_ranges(
            end_date=dt("2026-08-07"),  # Cuma
            quantity=1,
            product_params=BASIC_PARAMS,
            emp=ONE_EMPLOYEE,
            work_minutes=WORK_MINUTES,
            holidays=NO_HOLIDAYS,
        )
        assert [b["key"] for b in blocks] == BLOCK_KEYS
        # Her blok bir öncekinin bittiği yerde başlar (boşluk/örtüşme yok)
        for onceki, sonraki in zip(blocks, blocks[1:]):
            assert onceki["end"] == sonraki["start"]
        # Son blok, verilen bitiş tarihinde biter
        assert blocks[-1]["end"] == dt("2026-08-07")

    def test_hafta_sonuna_denk_gelen_bitis_bir_gun_erken_baslamaz(self):
        """date_utils.py:382-394'teki uyarının regresyon testi: end_date hafta
        sonuna denk geldiğinde `subtract_workdays` zaten doğru sonucu üretir.
        Fazladan bir "en yakın iş gününe yuvarla" adımı eklenirse start_date
        1 iş günü ERKEN çıkar — canlı veride görülen gerçek bir bug'dı."""
        cuma = calculate_split_stage_ranges(
            end_date=dt("2026-08-07"), quantity=1, product_params=BASIC_PARAMS,
            emp=ONE_EMPLOYEE, work_minutes=WORK_MINUTES, holidays=NO_HOLIDAYS,
        )
        cumartesi = calculate_split_stage_ranges(
            end_date=dt("2026-08-08"), quantity=1, product_params=BASIC_PARAMS,
            emp=ONE_EMPLOYEE, work_minutes=WORK_MINUTES, holidays=NO_HOLIDAYS,
        )
        # Cumartesi bitişli split, Cuma bitişliden tam 1 takvim günü sonra başlar —
        # 2 gün değil (çift atlama olsaydı 2 olurdu).
        fark = cumartesi[0]["start"] - cuma[0]["start"]
        assert fark.days == 1

    def test_tatil_bloklari_uzatir(self):
        tatilsiz = calculate_split_stage_ranges(
            end_date=dt("2026-08-07"), quantity=1, product_params=BASIC_PARAMS,
            emp=ONE_EMPLOYEE, work_minutes=WORK_MINUTES, holidays=NO_HOLIDAYS,
        )
        tatilli = calculate_split_stage_ranges(
            end_date=dt("2026-08-07"), quantity=1, product_params=BASIC_PARAMS,
            emp=ONE_EMPLOYEE, work_minutes=WORK_MINUTES,
            holidays={date(2026, 8, 5), date(2026, 8, 6)},
        )
        assert tatilli[0]["start"] < tatilsiz[0]["start"]

    def test_include_delivery_false_teslimat_blogunu_hic_uretmez(self):
        """BOM bileşen split'leri müşteriye teslim edilmez — Teslimat adımı hiç
        yoktur. Bloğu sonradan listeden filtrelemek YETMEZ: o zaman bile
        Teslimat'ın iş günü süresi geri sayımdan düşülmüş olur ve önceki tüm
        bloklar 1 iş günü erken kayar (date_utils.py:518-527)."""
        blocks = calculate_split_stage_ranges(
            end_date=dt("2026-08-07"), quantity=1, product_params=BASIC_PARAMS,
            emp=ONE_EMPLOYEE, work_minutes=WORK_MINUTES, holidays=NO_HOLIDAYS,
            include_delivery=False,
        )
        keys = [b["key"] for b in blocks]
        assert "delivery" not in keys
        assert keys == ["supply", "assembly", "production", "test"]
        # Son blok (test) verilen bitiş tarihinde biter — hayalet Teslimat günü yok
        assert blocks[-1]["end"] == dt("2026-08-07")

    def test_calculate_split_start_date_en_erken_blok_baslangicini_verir(self):
        kwargs = dict(
            end_date=dt("2026-08-07"), quantity=1, product_params=BASIC_PARAMS,
            emp=ONE_EMPLOYEE, work_minutes=WORK_MINUTES, holidays=NO_HOLIDAYS,
        )
        blocks = calculate_split_stage_ranges(**kwargs)
        assert calculate_split_start_date(**kwargs) == min(b["start"] for b in blocks)


class TestBomZamanlama:
    """BOM ana siparişi: bileşenler ana ürünün Dizgi'sinin yerine geçer.
    Ana ürün, bileşenler üretilirken PARALEL olarak Tedarik yapar."""

    BOM_KWARGS = dict(
        quantity=1, product_params=BASIC_PARAMS, emp=ONE_EMPLOYEE,
        work_minutes=WORK_MINUTES, holidays=NO_HOLIDAYS,
    )

    def test_dizgi_blogu_tamamen_atlanir(self):
        """Dizgi, döngü İÇİNDE ve süre tüketilmeden ÖNCE atlanır. Eskiden döngüden
        SONRA listeden filtreleniyordu — süresi yine de düşülüyor, Tedarik birkaç
        gün erken hesaplanıyordu (date_utils.py:371-379)."""
        blocks = calculate_split_stage_ranges(
            end_date=dt("2026-08-14"), component_ready_at=dt("2026-08-03"),
            start_date=dt("2026-07-20"), **self.BOM_KWARGS,
        )
        assert "assembly" not in [b["key"] for b in blocks]

    def test_tedarik_bilesenler_hazir_olana_kadar_uzar(self):
        """Tedarik, start_date'ten başlar ve component_ready_at'e KADAR sürer —
        kendi yapılandırılmış süresi yalnızca bir alt sınırdır
        (date_utils.py:442-452)."""
        blocks = blocks_by_key(calculate_split_stage_ranges(
            end_date=dt("2026-08-14"), component_ready_at=dt("2026-08-03"),
            start_date=dt("2026-07-20"), **self.BOM_KWARGS,
        ))
        supply = blocks["supply"]
        assert supply["start"] == dt("2026-07-20")   # start_date'ten başlar
        assert supply["end"] == dt("2026-08-03")     # bileşenler hazır olana kadar

    def test_component_ready_at_hafta_sonundan_geri_yuvarlanir(self):
        """component_ready_at, bileşen split'lerinin HAM end_date'inden (MAX)
        gelir; bileşenlerde Teslimat olmadığı için bu bir teslimat tarihi değil,
        sadece hesap çıpasıdır. Hafta sonuna denk geldiğinde bileşenin GERÇEK son
        iş günü bir önceki Cuma'dır — yuvarlanmazsa ana montaj hafta sonu boyunca
        bekliyormuş gibi uzar (date_utils.py:354-365)."""
        blocks = blocks_by_key(calculate_split_stage_ranges(
            end_date=dt("2026-08-21"),
            component_ready_at=dt("2026-08-09"),  # PAZAR
            start_date=dt("2026-07-20"), **self.BOM_KWARGS,
        ))
        # Pazar (08-09) -> geriye doğru en yakın iş günü: Cuma (08-07)
        assert blocks["supply"]["end"] == dt("2026-08-07")

    def test_bilesenler_gec_biterse_sonraki_bloklar_ileri_kaydirilir(self):
        """component_ready_at, geriye doğru hesaplanan Üretim başlangıcından
        SONRAYSA, Üretim/Test/Teslimat ileri kaydırılır (date_utils.py:409-430)."""
        erken = blocks_by_key(calculate_split_stage_ranges(
            end_date=dt("2026-08-28"), component_ready_at=dt("2026-08-03"),
            start_date=dt("2026-07-20"), **self.BOM_KWARGS,
        ))
        # Üretim geriye doğru hesapta 2026-08-24'te başlıyor; kaydırmanın
        # tetiklenmesi için component_ready_at bundan KESİN OLARAK sonra olmalı
        # (koşul `>`, eşitlikte kaydırma yapılmaz).
        assert erken["production"]["start"] == dt("2026-08-24")
        gec = blocks_by_key(calculate_split_stage_ranges(
            end_date=dt("2026-08-28"), component_ready_at=dt("2026-08-26"),
            start_date=dt("2026-07-20"), **self.BOM_KWARGS,
        ))
        assert gec["production"]["start"] > erken["production"]["start"]
        # Kaydırılan Üretim, bileşenlerin hazır olduğu günden önce başlayamaz
        assert gec["production"]["start"] >= dt("2026-08-26")

    def test_bilesenler_tam_sinirda_bitiyorsa_kaydirma_yapilmaz(self):
        """Kaydırma koşulu `component_ready_at > next_block.start` — EŞİTLİK
        durumunda blok doğal yerinde bırakılır."""
        blocks = blocks_by_key(calculate_split_stage_ranges(
            end_date=dt("2026-08-28"), component_ready_at=dt("2026-08-24"),
            start_date=dt("2026-07-20"), **self.BOM_KWARGS,
        ))
        assert blocks["production"]["start"] == dt("2026-08-24")


class TestComponentEndDate:
    """Bileşen (alt ürün) siparişleri İLERİ yönlü hesaplanır: Teslimat bloğu
    yoktur (bileşen müşteriye gitmez) ama Dizgi ATLANMAZ — bileşenin kendi
    normal dizgisi çalışır (date_utils.py:483-485)."""

    def test_ileri_yonlu_hesap_baslangictan_sonra_biter(self):
        son = calculate_component_end_date(
            start_date=dt("2026-08-03"), quantity=1, product_params=BASIC_PARAMS,
            emp=ONE_EMPLOYEE, work_minutes=WORK_MINUTES, holidays=NO_HOLIDAYS,
        )
        assert son > dt("2026-08-03")

    def test_daha_fazla_adet_daha_gec_bitirir(self):
        per_unit = {**BASIC_PARAMS, "duration_mode": "per_unit", "assembly_days": 1}
        az = calculate_component_end_date(
            start_date=dt("2026-08-03"), quantity=1, product_params=per_unit,
            emp=ONE_EMPLOYEE, work_minutes=WORK_MINUTES, holidays=NO_HOLIDAYS,
        )
        cok = calculate_component_end_date(
            start_date=dt("2026-08-03"), quantity=20, product_params=per_unit,
            emp=ONE_EMPLOYEE, work_minutes=WORK_MINUTES, holidays=NO_HOLIDAYS,
        )
        assert cok > az


# --- Parametre çözümleme ------------------------------------------------------


class TestEffectiveSplitQuantity:
    """Hesaba giren efektif miktar = quantity - on_hand_quantity, en az 0."""

    class _Split:
        def __init__(self, quantity, on_hand_quantity=None):
            self.quantity = quantity
            self.on_hand_quantity = on_hand_quantity

    def test_eldeki_stok_ihtiyactan_dusulur(self):
        assert effective_split_quantity(self._Split(10, 3)) == 7

    def test_stok_yoksa_tam_miktar(self):
        assert effective_split_quantity(self._Split(10, None)) == 10
        assert effective_split_quantity(self._Split(10, 0)) == 10

    def test_stok_ihtiyactan_fazlaysa_sifira_kirpilir(self):
        assert effective_split_quantity(self._Split(5, 12)) == 0


class TestEffectiveProductParams:
    def test_parca_override_siparis_degerini_ezer(self):
        birlesik = effective_product_params({"supply_days": 5, "delivery_days": 2}, {"supply_days": 9})
        assert birlesik["supply_days"] == 9
        assert birlesik["delivery_days"] == 2  # override'da yok -> miras alınır

    def test_override_yoksa_siparis_degerleri_aynen_gelir(self):
        assert effective_product_params({"supply_days": 5}, None) == {"supply_days": 5}

    def test_ikisi_de_bossa_bos_sozluk(self):
        assert effective_product_params(None, None) == {}


class TestBuildProductParams:
    """Excel içe aktarımları farklı Türkçe/İngilizce sütun adları kullanabilir;
    build_product_params bunları tek bir normalize sözlüğe indirger."""

    @pytest.mark.parametrize(
        "alias", ["supply_days", "tedarik_suresi", "tedarik_süresi", "lead_time"]
    )
    def test_tedarik_alaninin_es_anlamlilari(self, alias):
        assert build_product_params({alias: 4})["supply_days"] == 4.0

    @pytest.mark.parametrize(
        "alias", ["production_days", "assembly_days", "uretim_suresi", "üretim_süresi"]
    )
    def test_uretim_alaninin_es_anlamlilari(self, alias):
        assert build_product_params({alias: 3})["production_days"] == 3.0

    def test_metin_degerler_sayiya_cevrilir(self):
        assert build_product_params({"supply_days": "7"})["supply_days"] == 7.0

    def test_gecersiz_deger_none_dondurur_patlamaz(self):
        assert build_product_params({"supply_days": "abc"})["supply_days"] is None

    def test_bos_base_data_tum_alanlari_none_yapar(self):
        params = build_product_params(None)
        assert params["supply_days"] is None
        assert params["production_days"] is None


class TestIsOutsourcedFromBaseData:
    @pytest.mark.parametrize("deger", [True, "true", "1", "evet", "e", "fason", "yes"])
    def test_fason_olarak_taninan_degerler(self, deger):
        assert is_outsourced_from_base_data({"is_outsourced": deger}) is True

    @pytest.mark.parametrize("deger", [False, "false", "0", "hayir", "hayır", "h", "no"])
    def test_fason_olmayan_degerler(self, deger):
        assert is_outsourced_from_base_data({"is_outsourced": deger}) is False

    def test_uretim_tipi_alanindan_cikarim(self):
        assert is_outsourced_from_base_data({"uretim_tipi": "Fason üretim"}) is True
        assert is_outsourced_from_base_data({"uretim_tipi": "FASON"}) is True
        assert is_outsourced_from_base_data({"uretim_tipi": "iç üretim"}) is False
        assert is_outsourced_from_base_data({"uretim_tipi": "ic uretim"}) is False

    def test_turkce_buyuk_I_ile_yazilan_ic_uretim_taninmaz(self):
        """BİLİNEN KUSUR (mevcut davranış kilitleniyor, onaylanmıyor).

        Python'da "İ".lower() ASCII "i" değil, "i̇" (i + U+0307 birleşen nokta)
        üretir. Bu yüzden _FASON_MODE_FALSE_TOKENS içindeki "iç"/"ic" token'ları
        Türkçe büyük İ ile yazılmış değerlerde eşleşmez ve fonksiyon False yerine
        None döner.

        Neden şu an zararsız: None = "sinyal yok" demek ve çağıran taraf
        varsayılan olarak False (fason değil) kullanıyor — yani nihai sonuç
        kazara doğru çıkıyor. Ancak varsayılan bir gün değişirse bu sessizce
        yanlış sonuca döner.

        Düzeltmesi: karşılaştırmadan önce str.casefold() + Unicode normalizasyonu
        (NFKD ile U+0307 temizliği) uygulamak. Faz 2'de ele alınabilir."""
        assert is_outsourced_from_base_data({"uretim_tipi": "İç üretim"}) is None
        assert is_outsourced_from_base_data({"uretim_tipi": "İÇ ÜRETİM"}) is None

    def test_hicbir_sinyal_yoksa_none(self):
        """None = "bilgi yok" — çağıran taraf varsayılanına (genelde False) karar verir."""
        assert is_outsourced_from_base_data({}) is None
        assert is_outsourced_from_base_data(None) is None
