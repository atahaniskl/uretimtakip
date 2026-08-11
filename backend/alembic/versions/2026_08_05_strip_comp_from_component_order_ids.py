"""alt urun siparis numaralarindan "-COMP-" ara ekini kaldir

Revision ID: 2026080501
Revises: 2026072002
Create Date: 2026-08-05

Alt urun (bilesen) siparisleri otomatik olusturulurken numaralari
"{ana_siparis}-COMP-{urun_adi}" kalibindaydi (bkz. gantt.py). Ara ek gereksiz:
bir siparisin alt urun oldugu zaten urun adindan ve `parent_order_id` bagindan
anlasiliyor. Kod artik "{ana_siparis}-{urun_adi}" uretiyor; bu migration ayni
sadelestirmeyi VAR OLAN kayitlara uygular.

Guvenli mi: evet — `external_id` bu metne gore hicbir yerde ayristirilmiyor.
Alt urun tespiti her yerde parent_order_id/component_product_id uzerinden yapilir;
Excel yeniden-ice-aktarma eslemesi (excel_service db_lookup) yalnizca kullanicinin
kendi girdigi ANA siparis numaralarini eslestirir, otomatik uretilen alt urun
numaralarina dokunmaz.

Neden `replace(external_id, '-COMP-', '-')` DEGIL: replace TUM eslesmeleri degistirir.
Ana siparis numarasinin kendisi "-COMP-" icerirse (kullanici elle yazmis olabilir)
o kisim da bozulurdu. Bunun yerine ust siparisin numarasi CAPA alinir ve yalnizca
onun hemen ardindaki uretilmis ayrac kaldirilir.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "2026080501"
down_revision: Union[str, None] = "2026072002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Yalnizca "{ust_siparis_no}-COMP-" ile BASLAYAN alt urun kayitlari; ara ek
    # tam olarak o konumdan kaldirilir. Sonuc her zaman daha kisa oldugu icin
    # String(255) sinirini asma riski yok.
    op.execute(
        """
        UPDATE orders AS c
        SET external_id = p.external_id || '-' ||
            substring(c.external_id FROM length(p.external_id || '-COMP-') + 1)
        FROM orders AS p
        WHERE c.parent_order_id = p.id
          AND c.external_id LIKE p.external_id || '-COMP-%'
        """
    )

    # Ikinci gecis: ust siparisin numarasi alt urun olusturulduktan SONRA
    # degistirilmis olabilir (order_details ekranindan duzenlenebiliyor), o zaman
    # kayitli onek artik ust siparisle eslesmez ve yukaridaki capa tutmaz. Kalanlar
    # icin ilk "-COMP-" gecisi kaldirilir — `regexp_replace` 'g' bayragi OLMADAN
    # yalnizca ILK eslesmeyi degistirir, `replace`in tumunu degistirme riski yok.
    # Kapsam yine yalnizca alt urun siparisleri (parent_order_id dolu).
    op.execute(
        """
        UPDATE orders
        SET external_id = regexp_replace(external_id, '-COMP-', '-')
        WHERE parent_order_id IS NOT NULL
          AND external_id LIKE '%-COMP-%'
        """
    )


def downgrade() -> None:
    """Ara eki ust siparisin numarasini capa alarak geri koyar.

    KISMI: upgrade'in ikinci gecisiyle duzeltilen (ust siparisi sonradan yeniden
    adlandirilmis) kayitlar geri alinamaz — onlarda kayitli onek zaten ust siparisle
    eslesmiyor, yani "-COMP-"in tam olarak nereye girecegi bilinemez. Tahminle
    yerlestirmek numarayi bozacagi icin bilincli olarak dokunulmaz. Alan tamamen
    kozmetik oldugundan (hicbir yer bu metne gore eslesme yapmaz) bu kabul edilebilir.
    """
    # Zaten "-COMP-" tasiyan kayitlar haric tutulur ki migration iki kez calisirsa
    # "-COMP-COMP-" olusmasin. Geri koyma 6 karakter ekledigi icin sonuc 255'e
    # kirpilir (kolon sinirini asmasin).
    op.execute(
        """
        UPDATE orders AS c
        SET external_id = left(
            p.external_id || '-COMP-' ||
            substring(c.external_id FROM length(p.external_id || '-') + 1),
            255
        )
        FROM orders AS p
        WHERE c.parent_order_id = p.id
          AND c.external_id LIKE p.external_id || '-%'
          AND c.external_id NOT LIKE p.external_id || '-COMP-%'
        """
    )
