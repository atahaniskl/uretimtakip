type Tag = 'yeni' | 'düzeltme' | 'değişiklik';
type Entry = { tag: Tag; text: string };
type Release = { version: string; date: string; summary: string; entries: Entry[] };

const RELEASES: Release[] = [
  {
    version: 'v1.15.9',
    date: '7 Ağustos 2026',
    summary: 'Süre modu ve efor katsayısı kaldırıldı: Dizgi, Üretim ve Test artık her zaman adet başına hesaplanıyor. Alt parçalı siparişlerde Tedarik süresi düzeltildi. Mevcut siparişlerin planları olduğu gibi korunuyor.',
    entries: [
      { tag: 'değişiklik', text: 'Süre modu ("Adet Başına / İş Günü") kaldırıldı. Dizgi, Üretim ve Test her zaman adet başına hesaplanıyor; Ürün Bilgisi sayfasındaki mod kartı, rozetler ve "toplam gün" alanları kalktı.' },
      { tag: 'değişiklik', text: 'Mevcut siparişlerin aşama süreleri olduğu gibi sabitleniyor — hiçbir siparişin planı kendiliğinden değişmiyor. Adet başına hesaba dönmek için düzenleme ekranında ilgili süreyi silin.' },
      { tag: 'düzeltme', text: 'Alt parçalı siparişlerde ana ürünün Tedarik\'i 1 günde kalıyordu; artık alt parçaların başlangıcından hepsinin bitişine kadar sürüyor. Bu aralık Tedarik alanının yanında da yazıyor.' },
      { tag: 'düzeltme', text: 'Adet başına verisi girilmemiş bir aşama zaman çizelgesinden düşmüyor, en az 1 iş günü sayılıyor.' },
      { tag: 'yeni', text: 'Ürün Bilgisi tablosunda Üretim ve Test tek toplamda birleşmiyor; Kalite, Epoxy, Conformal, Montaj, M.Kalite, Test1, Test2 ve F.Test kendi sütunlarında.' },
      { tag: 'değişiklik', text: '"Sistem Önerisi" düğmesi "Çizelgeyi Yeniden Kur" oldu; ne yaptığı altında yazıyor ve basınca neyin değiştiğini — değişmediyse neden değişmediğini — söylüyor.' },
      { tag: 'değişiklik', text: 'Efor katsayısı kaldırıldı: hiçbir hesaba girmiyordu, ekranlardan ve Excel eşlemesinden çıkarıldı.' },
    ],
  },
  {
    version: 'v1.15.8',
    date: '6 Ağustos 2026',
    summary: 'Üretim parametrelerindeki iş günü karışıklığı giderildi: kutular artık çizelgenin gerçekten kullandığı süreyi gösteriyor ve sipariş özelinde her adımın kaç gün süreceğini siz yazabiliyorsunuz. Tarih alanları takvimden seçiliyor, alt ürün sipariş numaraları sadeleşti.',
    entries: [
      { tag: 'düzeltme', text: 'Üretim Parametreleri kutuları artık zaman çizelgesinin gerçekten kullandığı iş gününü gösteriyor. Kutuda "2,5" yazarken çizelgenin 40 iş günü sürmesi gibi çelişkiler kalktı; ekranda süre modu diye bir kavram da yok, her kutu iş günü.' },
      { tag: 'yeni', text: 'Sipariş özelinde her adımın kaç iş günü süreceğini yazabiliyorsunuz — yazdığınız değer kesindir. Dokunmadığınız alanlar ürünün adet başına sürelerinden hesaplanır; o süreler Ürün Bilgisi sayfasından düzenlenir.' },
      { tag: 'düzeltme', text: 'Yazdığınız gün sayısı kaydetmeden de zaman çizelgesine yansıyor; önceden süre ancak kaydedince değişiyordu.' },
      { tag: 'değişiklik', text: 'Alt ürün sipariş numaralarındaki "-COMP-" ara eki kaldırıldı (29999-COMP-A yerine 29999-A). Mevcut kayıtlar da güncelleniyor.' },
      { tag: 'değişiklik', text: 'Teslimat oluşturma ekranlarında tarih artık elle yazılamıyor, takvimden seçiliyor; ay adı yazıyla gösteriliyor ("20 Ağustos 2026").' },
      { tag: 'düzeltme', text: '"Özel Program — sistem önerisinden N farkı var" paneli açık temada okunmuyordu.' },
      { tag: 'yeni', text: 'Sağ panelde Düzenle düğmesinin altına, siparişin ve teslimat parçalarının nereden silineceğini söyleyen bir not eklendi.' },
    ],
  },
  {
    version: 'v1.15.7',
    date: '5 Ağustos 2026',
    summary: 'Sol menüye "İstatistikler" sayfası eklendi. Teslimat Takvimi\'nde bir bara sağ tıklayarak o siparişin bütün adımlarını görebiliyorsunuz.',
    entries: [
      { tag: 'yeni', text: 'Sol menüye, Sipariş Detayları\'nın altına "İstatistikler" sayfası eklendi: kalan iş, gecikme ve söz aşımı takibi, müşteri ve ürün kırılımları.' },
      { tag: 'yeni', text: 'İstatistiklerde teslimat dağılımı grafiği — Aylık ve Yıllık görünüm, oklarla dönemler arasında gezinme.' },
      { tag: 'yeni', text: 'Teslimat Takvimi\'nde bir bara sağ tık → "Alt adımları göster": takvimde yalnızca o sipariş ve bütün adımları kalıyor. "Normale dön" ya da Esc ile çıkılıyor.' },
    ],
  },
  {
    version: 'v1.15.6',
    date: '3 Ağustos 2026',
    summary: 'Sipariş Geçmişi kayıtları okunur hale geldi, alt ürünlü siparişlerdeki boş günler kapandı, Sipariş Detayları\'na "+ Teslimat" eklendi.',
    entries: [
      { tag: 'düzeltme', text: 'Sipariş Geçmişi kayıtları artık "Miktar: 10 → 13" gibi okunur bir özet taşıyor; önceden teknik alan adları ve ham kodlar yazıyordu.' },
      { tag: 'düzeltme', text: 'Sipariş geçmişinde 10 haneden uzun sipariş numaraları kırpılıyordu; artık tam yazılıyor, satırda ürün adı ve adet de var.' },
      { tag: 'düzeltme', text: 'Alt ürünlü siparişlerde Tedarik ile Üretim arasındaki boş günler kapandı; ana ürünün adedi değiştiğinde de yeniden hesaplanıyor.' },
      { tag: 'yeni', text: 'Sipariş düzenleme ekranında adet değişince zaman çizelgesi kaydetmeden güncelleniyor; alt ürün barları da birlikte.' },
      { tag: 'düzeltme', text: 'Adet değişince Üretim, Test ve Teslimat, Dizgi bitmeden başlayıp üst üste biniyordu; giderildi.' },
      { tag: 'yeni', text: 'Sipariş Detayları sayfasına "+ Teslimat" düğmesi eklendi.' },
      { tag: 'değişiklik', text: 'Teslimat Takvimi\'ndeki "Adım" görünümü geçici olarak gizlendi; "Detay" doğrudan Hiyerarşik Gantt\'ı açıyor.' },
    ],
  },
  {
    version: 'v1.15.5',
    date: '31 Temmuz 2026',
    summary: '"Denetim İzleri" sayfası menüde yer değiştirdi ve tüm kullanıcılara açıldı.',
    entries: [
      { tag: 'değişiklik', text: '"Denetim İzleri" sayfası "Görünüm Ayarları"nın altına taşındı ve artık yalnızca yöneticiler değil tüm kullanıcılar görebiliyor.' },
    ],
  },
  {
    version: 'v1.15.4',
    date: '30 Temmuz 2026',
    summary: 'Açık tema uyumu tamamlandı, üst çubuk sadeleştirildi, sol menü daraltıldı.',
    entries: [
      { tag: 'yeni', text: 'Sipariş Detayları\'nda her ürün satırının kendi oku var; alt ürünlerini gizliyor ve kaç tane olduğunu rozet olarak yazıyor.' },
      { tag: 'düzeltme', text: 'Takvim ve Sipariş Detayları\'ndaki görünüm anahtarları açık temada okunmuyordu; giderildi.' },
      { tag: 'düzeltme', text: 'Hiyerarşik Gantt\'ta kapatılan satırların özet barı açık temada zemine karışıyordu; giderildi.' },
      { tag: 'düzeltme', text: 'Takvim filtre panelindeki ayırıcı çizgiler açık temada kayboluyordu; giderildi.' },
      { tag: 'değişiklik', text: 'Üst çubuktaki "Bugün" / "Bu Yıl" düğmesi kaldırıldı.' },
      { tag: 'değişiklik', text: '"Aktif Siparişler" düğmesi artık yazı değiştirmiyor; durumu renginden anlaşılıyor.' },
      { tag: 'değişiklik', text: '"Alt Ürünleri Gizle" anahtarı "Alt Ürünler" oldu; kutu işaretliyken alt ürünler görünüyor.' },
      { tag: 'değişiklik', text: 'Sol menü %15 daraltıldı; sayfa içeriğine daha fazla yer kalıyor.' },
      { tag: 'düzeltme', text: 'Yatay Gantt\'ta Ctrl tuşu basılıyken fare tekerleğiyle yakınlaştırma çalışmıyordu; giderildi.' },
    ],
  },
  {
    version: 'v1.15.3',
    date: '29 Temmuz 2026',
    summary: 'Süre modundan kaynaklanan Dizgi süresi hatası giderildi, Ürün Bilgisi sadeleştirildi, Yatay Gantt\'a yakınlaştırma ve "Görünüm Ayarları" sayfası eklendi.',
    entries: [
      { tag: 'düzeltme', text: 'Süre modu seçilmemiş ürünlerde ekran "Adet Başına", hesap "İş Günü" kabul ediyor ve süreler sessizce yanlış çıkabiliyordu; ikisi aynı kurala getirildi.' },
      { tag: 'değişiklik', text: 'Ürün Bilgisi tek tabloya indirildi: 15 sütun yerine 9, her satırda süre modu rozeti ve o moda uygun birim.' },
      { tag: 'değişiklik', text: 'Ürün Bilgisi\'nde alt ürünler ayrı iç tablo yerine ana tablonun içinde girintili satırlar olarak açılıyor.' },
      { tag: 'değişiklik', text: 'İş Günü modunda gereksiz olan "Dizgi Süresi (gün/adet)" kutusu kaldırıldı.' },
      { tag: 'yeni', text: 'Sipariş oluştururken seçilen ürünün süre modu rozet olarak görünüyor.' },
      { tag: 'yeni', text: 'İş Günü modunda adet başına süresi girilmemiş aşamalar için önceden uyarı çıkıyor.' },
      { tag: 'yeni', text: 'Yatay Gantt\'a yakınlaştırma eklendi: %40–%300 arası sekiz kademe, Ctrl + fare tekerleği.' },
      { tag: 'yeni', text: 'Hiyerarşik Gantt\'ta kapatılan satırlarda, gizlenen tüm adımları kapsayan tek bir özet bar çiziliyor.' },
      { tag: 'yeni', text: 'Sol menüye kişisel "Görünüm Ayarları" sayfası eklendi; tercihler yalnızca sizin tarayıcınızda saklanıyor.' },
      { tag: 'düzeltme', text: 'Teslimat Takvimi\'nde fason parçaların dizgi adımı düz "Dizgi" yazıyordu; artık "Fason (Dış Dizgi)".' },
      { tag: 'düzeltme', text: 'Yatay Gantt\'taki yazı boyutu ve açık temadaki alt ürün etiketi kontrastı düzeltildi.' },
      { tag: 'değişiklik', text: 'Aşama süreleri artık tüm ekranlarda tek bir ortak hesaptan geliyor.' },
    ],
  },
  {
    version: 'v1.15.2',
    date: '29 Temmuz 2026',
    summary: 'Teslimat Takvimi\'nin üst çubuğu tüm görünümlerde tek ve sabit hale getirildi.',
    entries: [
      { tag: 'düzeltme', text: 'Özet\'ten Detay\'a geçerken sayfanın tamamı "yükleniyor" ekranına dönüyordu; artık yalnızca takvim gövdesi yenileniyor.' },
      { tag: 'değişiklik', text: 'Her görünümün kendi üst çubuğu vardı; hepsi artık tek ve aynı çubuğu paylaşıyor.' },
      { tag: 'düzeltme', text: 'Üst çubuk, yan panel açılıp kapandıkça kayıyordu; artık sayfanın tam genişliğinde sabit duruyor.' },
      { tag: 'düzeltme', text: 'Pencere daraltılınca düğmeler alt satıra iniyordu; artık çubuk kendi içinde yatay kaydırılıyor.' },
      { tag: 'düzeltme', text: 'Etiketi değişen düğmeler yanlarındakileri oynatıyordu; düzen yeniden ayarlandı.' },
      { tag: 'düzeltme', text: '"Detay" menüsü Özet takviminde kesiliyordu; giderildi.' },
      { tag: 'düzeltme', text: 'Üst çubuktaki eksik Türkçe karakterler düzeltildi.' },
    ],
  },
  {
    version: 'v1.15.1',
    date: '24 Temmuz 2026',
    summary: 'Teslimat Takvimi\'ne yatay zaman çizgisi görünümü eklendi, "Firma" alanı kaldırıldı, dar ekran ve yıllık görünüm hataları düzeltildi.',
    entries: [
      { tag: 'yeni', text: 'Sipariş Detayları sayfasına basit görünüm modu eklendi.' },
      { tag: 'yeni', text: 'Hiyerarşik Gantt\'a "Yatay" görünüm eklendi: siparişin tüm adımları soldan sağa tek bir satırda akıyor, bugün kırmızı sütunla işaretleniyor.' },
      { tag: 'yeni', text: 'Yatay görünümde "Aylık / Yıllık" yakınlaştırma seviyesini değiştiriyor; baktığınız tarih ekranın ortasında sabit kalıyor.' },
      { tag: 'yeni', text: 'Yatay görünümde hafta sonu ve resmi tatiller ayrı renkte sütunlarla ayrılıyor; en altta renk açıklaması var.' },
      { tag: 'değişiklik', text: '"Firma" alanı tüm ekranlardan kaldırıldı; artık yalnızca "Müşteri" kullanılıyor.' },
      { tag: 'yeni', text: 'Aktif Siparişler\'de aynı numaralı farklı ürünler tek bir sepet gibi gruplanıp dallanma çizgisiyle gösteriliyor.' },
      { tag: 'yeni', text: 'Ürün Bilgisi\'nde alt ürünler ana listede ayrı satır olarak görünmüyor; ait oldukları ürünün altında açılıyor.' },
      { tag: 'değişiklik', text: 'Üretim Parametreleri yalnızca İş Günü modunda düzenlenebiliyor; adet başına süreler Ürün Bilgisi\'nden giriliyor.' },
      { tag: 'yeni', text: 'Üretim veya Teslimat, Dizgi bitmeden bitecek şekilde ayarlanırsa uyarı çıkıyor ve kaydedilemiyor.' },
      { tag: 'yeni', text: 'Özet takvime "Alt Ürünleri Gizle" seçeneği eklendi; parçalı teslimatlar bundan etkilenmiyor.' },
      { tag: 'düzeltme', text: 'Teslimat Takvimi telefonda ve dar pencerede bozuk görünüyordu; paneller artık otomatik daralıyor.' },
      { tag: 'düzeltme', text: 'Yıllık takvimde pencere daraltılınca 12 aydan sadece birkaçı görünüyordu; giderildi.' },
      { tag: 'düzeltme', text: 'Hiyerarşik Gantt\'ın yıllık görünümünde ay adı artık kaydırma sırasında üstte takip ediyor.' },
      { tag: 'düzeltme', text: 'Fason adımı Üretim ile aynı renkteydi; artık kendi rengiyle gösteriliyor.' },
      { tag: 'düzeltme', text: 'Hiyerarşik Gantt, sipariş silinince veya düzenlenince kendini yenilemiyordu; giderildi.' },
      { tag: 'değişiklik', text: 'Hiyerarşik Gantt\'ın sağ üstündeki sipariş sayısı kaldırıldı.' },
    ],
  },
  {
    version: 'v1.15',
    date: '22 Temmuz 2026',
    summary: 'Alt ürünlerde elde mevcut stok, otomatik bölünme, aylık abonelik, 3 adımlı "Teslimat Ekle" sihirbazı ve çok sayıda tarih hesabı düzeltmesi.',
    entries: [
      { tag: 'yeni', text: 'Alt ürünler için "Elde Mevcut" stok girilebiliyor; yalnızca gerçekten üretilecek miktar planlanıyor.' },
      { tag: 'yeni', text: 'Ana sipariş parçalara bölününce veya adedi değişince bağlı alt ürün siparişleri otomatik güncelleniyor.' },
      { tag: 'yeni', text: 'Sipariş oluştururken "Abonelik (Aylık)" seçeneği eklendi; sipariş tek tıkla aylık teslimat parçalarına bölünüyor.' },
      { tag: 'yeni', text: '"Yeni Teslimat Ekle" 3 adımlı bir sihirbaz oldu: ürün → adet → teslim tarihi; başlangıç ve iş günü otomatik hesaplanıyor.' },
      { tag: 'yeni', text: 'Sağ panel sadeleştirildi: tek bir "Düzenle" düğmesi doğrudan detay penceresini açıyor, açık parçanın barları sürekli vurgulu duruyor.' },
      { tag: 'yeni', text: '"Sistem Önerisi" Gün modunda boş bırakılan Dizgi/Üretim/Test alanlarını adet başına verilerden otomatik dolduruyor.' },
      { tag: 'yeni', text: 'Sol menüdeki "Yönetim" bölümü katlanabilir oldu; barların üzerinde atanan çalışan sayısı görünüyor.' },
      { tag: 'yeni', text: 'Yıllık Gantt ızgarasında resmi tatiller hafta sonu gibi ayrı renkle işaretleniyor.' },
      { tag: 'değişiklik', text: 'Alt ürünlü ana ürün kartlarında işlevsiz olan Dizgi alanları gösterilmiyor.' },
      { tag: 'değişiklik', text: '"Sistem Önerisi" ile doldurulan çizelge "Özel Program" değil, ayrı bir rozetle gösteriliyor.' },
      { tag: 'değişiklik', text: 'Sipariş Detayları\'nda tek teslimatlı siparişler de genişletilebilir başlık olarak gösteriliyor.' },
      { tag: 'düzeltme', text: 'Alt ürünlü siparişlerde Dizgi atlama hatası başlangıç tarihini bir yıldan fazla kaydırabiliyordu; giderildi.' },
      { tag: 'düzeltme', text: 'Alt ürün parçalarında olmaması gereken Teslimat adımı başlangıcı erkene alıyordu; giderildi.' },
      { tag: 'düzeltme', text: 'Sipariş bölünürken elde mevcut stok kayboluyordu; artık parçalar arasında korunuyor.' },
      { tag: 'düzeltme', text: 'Sipariş silme/bölme işlemi başarılı olsa bile hata mesajı gösteriliyordu; giderildi.' },
      { tag: 'düzeltme', text: 'Çok büyük adet girilince tarayıcı donuyordu; üst sınır eklendi.' },
      { tag: 'düzeltme', text: 'Vurgulanan bir bar "Düzenle" penceresinin önüne çıkabiliyordu; giderildi.' },
      { tag: 'düzeltme', text: 'Sipariş listesinde bir grup kapatılınca sayfa yukarı zıplıyordu; kaydırma konumu korunuyor.' },
      { tag: 'düzeltme', text: 'Yıllık ızgarada olmayan günler ve açık temadaki alt ürün etiketleri okunmuyordu; kontrast düzeltildi.' },
    ],
  },
  {
    version: 'v1.14.4',
    date: '18 Temmuz 2026',
    summary: 'Zaman çizelgesindeki tarih kayması ve alt ürünlerde yanlış "Sistem Önerisi" hesabı düzeltildi.',
    entries: [
      { tag: 'düzeltme', text: 'Kaydedilmiş bir zaman çizelgesi tekrar açıldığında tüm bloklar 1 gün erken gösteriliyordu; giderildi.' },
      { tag: 'düzeltme', text: 'Alt ürünlerde "Sistem Önerisi", olmaması gereken bir Teslimat süresini hesaba katıp çizelgeyi erkene kaydırıyordu.' },
      { tag: 'düzeltme', text: '"Özel Program" durumu artık kaydettikten hemen sonra güncelleniyor; öncesinde pencereyi kapatıp açmak gerekiyordu.' },
    ],
  },
  {
    version: 'v1.14.3',
    date: '16 Temmuz 2026',
    summary: 'Teslimat Takvimi\'ne ilişkili barları vurgulayan hover efekti eklendi, alt ürün etiketleri sadeleştirildi.',
    entries: [
      { tag: 'yeni', text: 'Özet takvimde bir bara fare ile gelince aynı siparişin tüm barları vurgulanıyor: ana sipariş mavi, alt ürünler kehribar.' },
      { tag: 'değişiklik', text: 'Sipariş Detayları\'nda alt ürün satırlarındaki "Alt Ürün:" öneki kaldırıldı.' },
      { tag: 'değişiklik', text: 'Takvimlerde alt ürün barlarındaki "Alt Ürün:" yazısı yerine 📦 simgesi kullanılıyor.' },
      { tag: 'değişiklik', text: 'Özet takvimde alt ürün barlarında tekrar eden adım adı ve adet gösterilmiyor; sadece ürün adı var.' },
      { tag: 'düzeltme', text: 'Sipariş numarası olmayan ("?") siparişler artık tek bile olsa açılır grup başlığı altında gösteriliyor.' },
    ],
  },
  {
    version: 'v1.14.2',
    date: '14 Temmuz 2026',
    summary: 'Gün öneri desteği getirildi, takvim görünüm düzeltmeleri yapıldı.',
    entries: [
      { tag: 'yeni', text: 'Üretim Parametreleri\'nde toplam-gün kutularının yanında hesaplanan bir "Öneri" gösteriliyor.' },
      { tag: 'yeni', text: 'Sipariş düzenleme ekranında "Özel Program" durumu kaydetmeden görünüyor; sistem önerisinden farkları gösteren panel eklendi.' },
      { tag: 'yeni', text: 'Alt ürünü olan siparişlerde Dizgi adımı ayrı seçilemiyor, Tedarik ile birlikte otomatik tamamlanıyor.' },
      { tag: 'yeni', text: 'Yeni Teslimat Ekle ekranı yeniden tasarlandı; yeni ürün eklerken Süre Modu seçilebiliyor.' },
      { tag: 'yeni', text: 'Özet takvimde artık alt ürünler ve parçaları da listeleniyor.' },
    ],
  },
  {
    version: 'v1.14.1',
    date: '13 Temmuz 2026',
    summary: 'Ürün adımlarında sorun oluşturabilecek hatalar önlendi, Yeni Teslimat Ekle ekranı güncellendi.',
    entries: [
      { tag: 'düzeltme', text: 'Ürün adımlarında sorun oluşturabilecek hatalar önlendi.' },
      { tag: 'yeni', text: 'Yeni Teslimat Ekle ekranı güncellendi.' },
    ],
  },
  {
    version: 'v1.14',
    date: '10 Temmuz 2026',
    summary: 'Ürünlere alt ürün tanımlama ve alt ürünlerin önce üretilmesini sağlayan zamanlama desteği.',
    entries: [
      { tag: 'yeni', text: 'Ürünlere alt ürün tanımlanabiliyor; sipariş oluşturunca alt ürünler otomatik olarak önce üretilecek şekilde planlanıyor.' },
      { tag: 'yeni', text: 'Alt ürünler Sipariş Detayları, önizleme ekranı ve Hiyerarşik Gantt\'ta ayrı ayrı görüntülenip düzenlenebiliyor.' },
      { tag: 'yeni', text: 'Alt ürünler de parçalı teslimata bölünebiliyor.' },
      { tag: 'yeni', text: 'Sağ panelde alt ürünü olan siparişler için gösterge eklendi.' },
    ],
  },
  {
    version: 'v1.13',
    date: '5 Temmuz 2026',
    summary: 'Sipariş Detayları için önizlemeli düzenleme penceresi, parça bazlı söz verilen tarih ve çok sayıda zamanlama düzeltmesi.',
    entries: [
      { tag: 'yeni', text: 'Sipariş Detayları\'nda bir kaleme tıklayınca tüm parçaları ve üretim parametrelerini tek ekranda gösteren "Sipariş Detayı" penceresi açılıyor.' },
      { tag: 'yeni', text: 'Zaman çizelgesi pencere içinde sürüklenip bırakılabiliyor; "Sistem Önerisi" ile sıfırdan da önerilebiliyor.' },
      { tag: 'yeni', text: 'Çalışan sayıları pencere içinden düzenlenebiliyor; kapasite çakışması anlık uyarı olarak gösteriliyor.' },
      { tag: 'yeni', text: 'Her teslimat parçasına kendi bağımsız "söz verilen teslim tarihi" tanımlanabiliyor.' },
      { tag: 'yeni', text: '"Adet/Gün" süre modu eklendi: süreler adet başına yerine düz toplam iş günü olarak da girilebiliyor.' },
      { tag: 'yeni', text: 'Kaydetmeden önceki tüm değişiklikler eski/yeni değerleriyle bir "Değişiklikler" özetinde listeleniyor.' },
      { tag: 'yeni', text: 'Bildirimler artık ekranın sağ üstünde gösteriliyor.' },
      { tag: 'düzeltme', text: 'Çok parçalı siparişlerde genel durum rozeti "Tedarik"te donuk kalıyordu; artık parçalar ilerledikçe güncelleniyor.' },
      { tag: 'düzeltme', text: 'Fason siparişlerde sağ paneldeki süre tahmini ve geç başlama uyarısı artık doğru hesaplanıyor.' },
      { tag: 'düzeltme', text: '"İş Günü (Toplam)" modu artık sağ panel, Gantt ve Teslimat Takvimi\'nde de hesaba katılıyor.' },
      { tag: 'düzeltme', text: 'Parçalı teslimatta girilen fason süresinin eski üretim süresi tarafından ezilmesi giderildi.' },
      { tag: 'düzeltme', text: 'Çizelge elle kaydırılırken gecikme uyarısı artık o parçanın kendi söz verilen tarihine bakıyor.' },
      { tag: 'düzeltme', text: 'Fason süresi artık sağ panel, "Teslimat Ekle" ve Excel içe aktarmanın hepsinde zamanlamaya doğru yansıyor.' },
      { tag: 'düzeltme', text: 'Çalışan sayısı düzenlenirken her tuşta çalışan gereksiz kapasite kontrolü kaldırıldı.' },
    ],
  },
  {
    version: 'v1.12',
    date: '30 Haziran 2026',
    summary: 'Fason (dış dizgi) üretim desteği ve çeşitli arayüz iyileştirmeleri.',
    entries: [
      { tag: 'yeni', text: 'Fason (dış dizgi) üretim desteği — sipariş bazında açılıp kapatılabiliyor.' },
      { tag: 'yeni', text: 'Fason siparişlerde dizgi süresi çalışan sayısına bölünmüyor; doğrudan "Fason Süresi (gün)" kullanılıyor.' },
      { tag: 'yeni', text: 'Gantt\'ta fason dizgi barı "Fason (Dış Dizgi)" olarak görünüyor.' },
      { tag: 'yeni', text: 'Sağ panele fason sipariş bilgi bandı ve aşama çizelgesine etiket eklendi.' },
      { tag: 'yeni', text: 'Fason siparişler çalışan kapasitesi hesabının dışında tutuluyor.' },
      { tag: 'değişiklik', text: 'Düzenle formunda Teslimat ve Başlangıç tarihi alanlarının sırası değişti.' },
      { tag: 'düzeltme', text: 'Düzenle formunda başlangıç ve teslimat aynı tarihi gösteriyordu; başlangıç artık bitişten geriye hesaplanıyor.' },
      { tag: 'düzeltme', text: 'Manuel teslimat eklerken fason anahtarı değişince toplam süre güncellenmiyordu.' },
    ],
  },
];

const TAG_META: Record<Tag, { label: string; cls: string }> = {
  yeni:        { label: 'yeni',        cls: 'bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30' },
  düzeltme:    { label: 'düzeltme',    cls: 'bg-red-500/15 text-red-400 ring-1 ring-red-500/30' },
  değişiklik:  { label: 'değişiklik',  cls: 'bg-blue-500/15 text-blue-400 ring-1 ring-blue-500/30' },
};

export default function ReleaseNotesPage() {
  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="mb-8">
        <h1 className="text-xl font-semibold text-surface-100">Sürüm Notları</h1>
      </div>

      <div className="relative">
        {/* Dikey zaman çizgisi */}
        <div className="absolute left-[7px] top-2 bottom-0 w-px bg-surface-700/60" />

        <div className="space-y-10">
          {RELEASES.map((r) => (
            <div key={r.version} className="relative pl-8">
              {/* Zaman çizelgesi noktası */}
              <div className="absolute left-0 top-1.5 w-3.5 h-3.5 rounded-full bg-primary-500 ring-4 ring-surface-950" />

              {/* Başlık */}
              <div className="flex items-baseline gap-3 mb-1">
                <span className="text-base font-bold text-surface-100">{r.version}</span>
                <span className="text-xs text-surface-500">{r.date}</span>
              </div>
              <p className="text-sm text-surface-400 mb-4">{r.summary}</p>

              {/* Maddeler */}
              <div className="card divide-y divide-surface-700/40">
                {r.entries.map((e, i) => {
                  const meta = TAG_META[e.tag];
                  return (
                    <div key={i} className="flex items-start gap-3 px-4 py-3">
                      <span className={`mt-0.5 shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded ${meta.cls}`}>
                        {meta.label}
                      </span>
                      <span className="text-sm text-surface-300 leading-relaxed">{e.text}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
