"""
BOM (alt urun) zamanlama yardimcilari — gantt.py ve order_details.py arasinda
paylasilan, tek kaynak sorgu. Bir siparisin bilesen (component) siparislerinin
en gec bittigi tarihi bulur (BOM ana siparisinin Dizgi'yi atlayip Uretim'e
gecebilecegi ilk an).
"""

import uuid
from datetime import datetime

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.delivery_split import DeliverySplit
from app.models.order import Order


async def get_components_ready_at(db: AsyncSession, order_id: uuid.UUID) -> datetime | None:
    result = await db.execute(
        select(func.max(DeliverySplit.end_date))
        .join(Order, Order.id == DeliverySplit.order_id)
        .where(Order.parent_order_id == order_id, Order.is_deleted == False, DeliverySplit.is_deleted == False)  # noqa: E712
    )
    return result.scalar_one_or_none()


async def get_components_ready_at_map(
    db: AsyncSession, order_ids: list[uuid.UUID]
) -> dict[uuid.UUID, datetime]:
    """`get_components_ready_at`'in coklu-siparis (toplu) hali — /gantt/tasks gibi
    tum siparisleri tek seferde isleyen uc noktalarda N+1 sorgudan kacinmak icin."""
    if not order_ids:
        return {}
    result = await db.execute(
        select(Order.parent_order_id, func.max(DeliverySplit.end_date))
        .join(Order, Order.id == DeliverySplit.order_id)
        .where(
            Order.parent_order_id.in_(order_ids),
            Order.is_deleted == False,  # noqa: E712
            DeliverySplit.is_deleted == False,  # noqa: E712
        )
        .group_by(Order.parent_order_id)
    )
    return {parent_id: ready_at for parent_id, ready_at in result.all()}


async def get_component_ready_at_for_split(
    db: AsyncSession, main_split_id: uuid.UUID
) -> datetime | None:
    """`get_components_ready_at`'in PARCA-bazli hali — bir ana siparisin split'i
    N parcaya bolunmusse (bkz. DeliverySplit.source_main_split_id, gantt.py'daki
    _sync_component_orders_for_main_split_replace), HER parca yalnizca KENDISINE
    baglanan (source_main_split_id ile eslesen) bilesen parcalarinin bitisine gore
    gate'lenir — kardes parcalarinkine degil. Eslesen bilesen parcasi yoksa (legacy
    veri / manuel olarak henuz baglanmamis) None doner — cagiran taraf order-seviyeli
    `get_components_ready_at`'e fallback yapmali."""
    result = await db.execute(
        select(func.max(DeliverySplit.end_date))
        .join(Order, Order.id == DeliverySplit.order_id)
        .where(
            DeliverySplit.source_main_split_id == main_split_id,
            Order.is_deleted == False,  # noqa: E712
            DeliverySplit.is_deleted == False,  # noqa: E712
        )
    )
    return result.scalar_one_or_none()


async def get_components_start_at(db: AsyncSession, order_id: uuid.UUID) -> datetime | None:
    """`get_components_ready_at`'in AYNADAKI hali: bilesenlerin EN ERKEN basladigi an.

    Ana urunun Tedarik'i bilesenlerle PARALEL calisir; o cubugun bitisi
    `get_components_ready_at` (MAX), baslangici ise burasi (MIN). MIN aliniyor
    cunku siparisin `start_date`'i "bu siparise ne zaman is baslar" demek — MAX
    alinsaydi ana siparisin baslangici kendi alt parcasinin baslangicindan sonra
    olurdu (bkz. date_utils.calculate_split_start_date'deki ayni gerekce).
    """
    result = await db.execute(
        select(func.min(DeliverySplit.start_date))
        .join(Order, Order.id == DeliverySplit.order_id)
        .where(Order.parent_order_id == order_id, Order.is_deleted == False, DeliverySplit.is_deleted == False)  # noqa: E712
    )
    return result.scalar_one_or_none()


async def get_components_start_at_map(
    db: AsyncSession, order_ids: list[uuid.UUID]
) -> dict[uuid.UUID, datetime]:
    """`get_components_start_at`'in coklu-siparis (toplu) hali — bkz.
    `get_components_ready_at_map` ile ayni N+1 gerekcesi."""
    if not order_ids:
        return {}
    result = await db.execute(
        select(Order.parent_order_id, func.min(DeliverySplit.start_date))
        .join(Order, Order.id == DeliverySplit.order_id)
        .where(
            Order.parent_order_id.in_(order_ids),
            Order.is_deleted == False,  # noqa: E712
            DeliverySplit.is_deleted == False,  # noqa: E712
        )
        .group_by(Order.parent_order_id)
    )
    return {parent_id: start_at for parent_id, start_at in result.all()}


async def get_component_start_at_for_split(
    db: AsyncSession, main_split_id: uuid.UUID
) -> datetime | None:
    """`get_components_start_at`'in PARCA-bazli hali — `get_component_ready_at_for_split`
    ile ayni eslestirme (source_main_split_id), yalnizca MIN(start_date)."""
    result = await db.execute(
        select(func.min(DeliverySplit.start_date))
        .join(Order, Order.id == DeliverySplit.order_id)
        .where(
            DeliverySplit.source_main_split_id == main_split_id,
            Order.is_deleted == False,  # noqa: E712
            DeliverySplit.is_deleted == False,  # noqa: E712
        )
    )
    return result.scalar_one_or_none()


async def get_components_ready_at_by_split_map(
    db: AsyncSession, main_split_ids: list[uuid.UUID]
) -> dict[uuid.UUID, datetime]:
    """`get_component_ready_at_for_split`'in coklu-split (toplu) hali — /gantt/tasks
    gibi tum split'leri tek seferde isleyen uc noktalarda N+1 sorgudan kacinmak icin."""
    if not main_split_ids:
        return {}
    result = await db.execute(
        select(DeliverySplit.source_main_split_id, func.max(DeliverySplit.end_date))
        .join(Order, Order.id == DeliverySplit.order_id)
        .where(
            DeliverySplit.source_main_split_id.in_(main_split_ids),
            Order.is_deleted == False,  # noqa: E712
            DeliverySplit.is_deleted == False,  # noqa: E712
        )
        .group_by(DeliverySplit.source_main_split_id)
    )
    return {main_split_id: ready_at for main_split_id, ready_at in result.all()}


async def cascade_soft_delete_components(
    db: AsyncSession, order_id: uuid.UUID, deleted_at: datetime
) -> int:
    """Bir ana siparis soft-delete edilirken (is_deleted=True) BOM bilesenlerini
    (parent_order_id ile bu siparise bagli Order'lar) ve onlarin delivery_split'lerini
    de soft-delete eder. FK'daki ondelete="CASCADE" yalnizca GERCEK DELETE'te
    tetiklenir — soft-delete bir UPDATE oldugu icin bu adim elle yapilmali, aksi
    halde bilesenler ana siparis silindikten sonra da is_deleted=False kalip
    Gantt/adim takviminde "yetim" (orphan) olarak gorunmeye devam eder.

    Donen deger: soft-delete edilen bilesen siparis sayisi (audit/response icin).
    """
    result = await db.execute(
        select(Order)
        .options(selectinload(Order.delivery_splits))
        .where(Order.parent_order_id == order_id, Order.is_deleted == False)  # noqa: E712
    )
    components = result.scalars().unique().all()
    for component in components:
        component.is_deleted = True
        component.deleted_at = deleted_at
        for split in component.delivery_splits:
            if not split.is_deleted:
                split.is_deleted = True
                split.deleted_at = deleted_at
    return len(components)


async def cascade_restore_components(
    db: AsyncSession, order_id: uuid.UUID, deleted_at: datetime | None
) -> int:
    """`cascade_soft_delete_components`'in tersi — bir ana siparis restore
    edilirken, TAM O ANDA (ayni deleted_at damgasiyla) cascade ile silinmis
    bilesenleri geri getirir. Bilesen deleted_at'i eslesmiyorsa (bilesen ana
    siparisten BAGIMSIZ, farkli bir zamanda elle silinmisse) DOKUNULMAZ — aksi
    halde ana siparisi restore etmek, ilgisiz sekilde daha once silinmis bir
    bileseni de sessizce geri getirirdi.

    deleted_at None ise (ana siparisin deleted_at'i bos/bilinmiyorsa) hicbir
    sey yapilmaz — eslestirme icin gereken referans yok demektir.
    """
    if deleted_at is None:
        return 0
    result = await db.execute(
        select(Order)
        .options(selectinload(Order.delivery_splits))
        .where(
            Order.parent_order_id == order_id,
            Order.is_deleted == True,  # noqa: E712
            Order.deleted_at == deleted_at,
        )
    )
    components = result.scalars().unique().all()
    for component in components:
        component.is_deleted = False
        component.deleted_at = None
        for split in component.delivery_splits:
            if split.is_deleted and split.deleted_at == deleted_at:
                split.is_deleted = False
                split.deleted_at = None
    return len(components)


async def cascade_soft_delete_linked_component_splits(
    db: AsyncSession, main_split_id: uuid.UUID, deleted_at: datetime
) -> int:
    """Bir ana siparişin TEK BİR parçası (DeliverySplit) silinirken — ama sipariş
    kendisi silinmeden, diğer parçalarıyla var olmaya devam ederken (bkz.
    delete_gantt_task'ın "remaining" dalı) — o parçaya `source_main_split_id` ile
    bağlı bileşen (component) parçalarını da soft-delete eder.
    `cascade_soft_delete_components`'ten farkı: TÜM bileşen SİPARİŞİNİ değil,
    yalnızca o siparişin bu belirli ana parçaya karşılık gelen TEK split'ini
    siler — bileşen siparişinin diğer parçaları (başka ana split'lere bağlı)
    etkilenmez.

    Dönen değer: soft-delete edilen bağlı bileşen split sayısı (audit/response icin).
    """
    result = await db.execute(
        select(DeliverySplit).where(
            DeliverySplit.source_main_split_id == main_split_id,
            DeliverySplit.is_deleted == False,  # noqa: E712
        )
    )
    linked_splits = result.scalars().all()
    for split in linked_splits:
        split.is_deleted = True
        split.deleted_at = deleted_at
    return len(linked_splits)


async def cascade_restore_linked_component_splits(
    db: AsyncSession, main_split_id: uuid.UUID, deleted_at: datetime | None
) -> int:
    """`cascade_soft_delete_linked_component_splits`'in tersi — bir ana parça
    restore edilirken, TAM O ANDA (aynı deleted_at damgasıyla) cascade ile
    silinmiş bağlı bileşen parçalarını geri getirir. deleted_at None ise
    (eşleştirme için gereken referans yoksa) hiçbir şey yapılmaz."""
    if deleted_at is None:
        return 0
    result = await db.execute(
        select(DeliverySplit).where(
            DeliverySplit.source_main_split_id == main_split_id,
            DeliverySplit.is_deleted == True,  # noqa: E712
            DeliverySplit.deleted_at == deleted_at,
        )
    )
    linked_splits = result.scalars().all()
    for split in linked_splits:
        split.is_deleted = False
        split.deleted_at = None
    return len(linked_splits)
