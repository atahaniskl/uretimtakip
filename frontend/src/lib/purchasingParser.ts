export interface PurchasingData {
  id: string;
  purchaseNo: string;
  purchasingAgent: string;
  approval: string;
  type: string;
  product: string;
  version: string;
  quantity: string;
  project: string;
  customer: string;
  proposalNo: string;
  listPrice: string;
  unitPriceEuro: string;
  unitPriceUsd: string;
  totalPriceUsd: string;
  company: string;
  supplier: string;
  orderDate: string;
  expectedDeliveryDate: string;
  deliveryDate: string;
  _sourceFile?: string;
}

export const COLUMNS: Array<{ key: keyof PurchasingData; label: string }> = [
  { key: 'purchaseNo',           label: 'Satın Alma No' },
  { key: 'purchasingAgent',      label: 'Satın Alım Sorumlusu' },
  { key: 'approval',             label: 'Onay' },
  { key: 'type',                 label: 'Tür (Komponent/PCB)' },
  { key: 'product',              label: 'Ürün' },
  { key: 'version',              label: 'Versiyon' },
  { key: 'quantity',             label: 'Adet' },
  { key: 'project',              label: 'Proje' },
  { key: 'customer',             label: 'Müşteri' },
  { key: 'proposalNo',           label: 'Teklif No' },
  { key: 'listPrice',            label: 'Liste Fiyatı' },
  { key: 'unitPriceEuro',        label: 'Br/Teklif (EURO)' },
  { key: 'unitPriceUsd',         label: 'Br/Teklif (USD)' },
  { key: 'totalPriceUsd',        label: 'Total Teklif (USD)' },
  { key: 'company',              label: 'Firma' },
  { key: 'supplier',             label: 'Tedarikçi' },
  { key: 'orderDate',            label: 'Sipariş Tarihi' },
  { key: 'expectedDeliveryDate', label: 'Öngörülen Teslimat Tarihi' },
  { key: 'deliveryDate',         label: 'Teslimat Tarihi' },
];

// ─── Firma ayarı ─────────────────────────────────────────────────────────────
// Teklif/PDF metinlerinde "müşteri" alanı, siparişi veren kendi firmamızın adıdır.
// Kendi kurulumunuzda .env dosyasına VITE_COMPANY_NAME=... yazarak değiştirin.
const COMPANY_NAME = (import.meta.env.VITE_COMPANY_NAME || 'Örnek Elektronik').trim();

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "Örnek Elektronik" → "Örnek\s+Elektronik" (tam ad eşleşmesi) */
const COMPANY_RE = COMPANY_NAME.split(/\s+/).map(escapeRe).join('\\s+');
/** "Örnek" (adres bloğu gibi yerlerde gevşek eşleşme için ilk kelime) */
const COMPANY_SHORT_RE = escapeRe(COMPANY_NAME.split(/\s+/)[0]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** İlk eşleşen regex'ten capture group 1'i döner, yoksa '' */
function g(text: string, ...patterns: RegExp[]): string {
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) {
      return m[1]
        .trim()
        .replace(/\r/g, '')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\s*<[^>]+>\s*/g, '') // mailto: vs. linkleri temizle
        .trim();
    }
  }
  return '';
}

/** Boşluk/CRLF'i normalize et — tüm ayrıştırmalarda kullan */
function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function detectType(desc: string): string {
  if (/ferrite|bead|capacitor|cap\b|resistor|res\b|inductor|diode|mosfet|transistor|oscillator|crystal|emi|emc|fuse|ic\b|chip|connector|header|socket|relay|plug|jack/i.test(desc)) return 'Komponent';
  if (/pcb|board|panel/i.test(desc)) return 'PCB';
  return '';
}

/** E-posta imza / disclaimer bloğunu kes (alınan e-postaların ilk kopyasını sakla) */
function firstReplyBlock(body: string): string {
  // "From: ...\nSent:" veya "Kimden: ...\nTarih:" gibi forward/reply ayracından öncesini al
  const cutAt = body.search(/\n(?:From|Kimden):.*\n(?:Sent|Date|Tarih|To|Kime):/i);
  return cutAt > 0 ? body.substring(0, cutAt) : body;
}

// ─── PDF metin çıkarımı ───────────────────────────────────────────────────────

export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  try {
    const lib = await import('pdfjs-dist');
    lib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href;
    const pdf = await lib.getDocument({ data: bytes }).promise;
    const pages: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      const lines: string[] = [];
      let lastY: number | null = null;
      for (const item of tc.items as any[]) {
        if (!('str' in item)) continue;
        const y = item.transform?.[5] ?? 0;
        if (lastY !== null && Math.abs(y - lastY) > 3) lines.push('\n');
        lines.push(item.str);
        lastY = y;
      }
      pages.push(lines.join(''));
    }
    return pages.join('\n\f\n');
  } catch (e) { console.warn('PDF parse:', e); return ''; }
}

// ─── FORMAT 1: Würth Elektronik PDF teklifi ──────────────────────────────────

function isWurth(text: string): boolean {
  return /quotation\s+no\./i.test(text) && /we-online\.com/i.test(text);
}

function extractWurthPdf(rawText: string): Partial<PurchasingData> {
  const text = normalize(rawText);

  const proposalNo  = g(text, /quotation\s+no\.?\s*:\s*\n+([A-Z0-9]+)/i);
  const orderDate   = g(text, /quotation\s+date\s*:\s*\n+([\d.]+)/i);
  const supplier    = g(text, /^(Würth Elektronik[^\n]*(?:Ltd|GmbH|Şti)[^\n]*)/im) || 'Würth Elektronik';
  const company     = supplier;

  // Müşteri: adres bloğundaki ilk şirket satırı (kendi firma adımızla başlayan satır)
  const customer    = g(text, new RegExp(`\\n(${COMPANY_SHORT_RE}[^\\n]+)\\n`, 'i'),
                               /\n([^\n]+(?:Ltd\.|A\.Ş\.|Şti\.)[^\n]*)\n/i);

  // Satış temsilcisi: "your sales agent:" sonrası — birden fazla boş satır olabilir
  const purchasingAgent = g(text, /your\s+(?:sales\s+agent|partner[^:\n]*)\s*:\s*\n+([^\n]+)/i);

  // Parça no: "001" satırından sonra gelen boş satırları geç, ilk alfanümerik token al
  const partNumMatch = text.match(/\n001\s*\n+([\s\S]{0,300})/);
  let partNumber = '';
  if (partNumMatch) {
    // ilk boş olmayan satır
    const lines = partNumMatch[1].split('\n').map(l => l.trim()).filter(Boolean);
    partNumber = lines[0] || '';
    // URL satırı ise atla
    if (/https?:\/\//i.test(partNumber)) partNumber = '';
    if (!partNumber && lines.length > 1) partNumber = lines[1] || '';
  }

  // Ürün açıklaması: URL satırından sonraki satır
  const product = g(text, /we-online\.com[^\n]*\n([^\n]{5,})/i) || partNumber;

  // Adet: "50 PCS" veya "8.000 PCS"
  const quantity = g(text, /([\d.,]+\s*PCS)/i);

  // Birim fiyat: "1.330,00 / 1000" veya "16,00 / 1000"
  const unitPriceEuro = g(text, /([\d]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})\s*\/\s*\d+)/,
                                 /([\d.,]+\s*\/\s*\d+)/);

  // Toplam EUR: "66,50\ncountry of origin"
  const totalMatch = text.match(/([\d.,]+)\s*\ncountry\s+of\s+origin/i);
  const totalPriceUsd = totalMatch ? totalMatch[1].trim() : '';

  // Teslimat tarihi: "22.05.2026" ardından rakam
  const expectedDeliveryDate = g(text, /(\d{2}\.\d{2}\.\d{4})\s*\n\s*[\d.,]/);

  return {
    proposalNo, orderDate, supplier, company, purchasingAgent,
    customer, product,
    version: partNumber !== product ? partNumber : '',
    quantity, unitPriceEuro, totalPriceUsd, expectedDeliveryDate,
    type: detectType(product),
  };
}

// ─── FORMAT 2: Düz e-posta gövdesi teklifi (Vorlance vb.) ───────────────────
// Örnek: "birim fiyatı : 27,05 USD + KDV", "555-SHHD003A0A41-SRZCT-ND x15"

function extractPlainEmailQuote(body: string, subject: string, senderName: string, senderEmail: string): Partial<PurchasingData> {
  const text = normalize(body);
  const firstBlock = firstReplyBlock(text); // sadece ilk yanıt bloğu

  // Parça numarası + adet: "555-SHHD003A0A41-SRZCT-ND x15" — tüm body'de ara (altta forward'da olabilir)
  const partLineMatch = text.match(/([A-Z0-9][A-Z0-9\-]{4,}(?:-ND)?)\s*x\s*(\d+)/i);
  const partNumber = partLineMatch?.[1] ?? '';
  const quantity   = partLineMatch?.[2] ?? '';

  // Birim fiyat USD: "27,05 USD" veya "27,242 USD"
  const unitPriceUsd = g(firstBlock,
    /birim\s*fiyat[ıi]\s*[:\s]+\s*([\d,\.]+\s*USD)/i,
    /fiyat[ıi]?\s*[:\s]+([\d,\.]+\s*USD)/i,
    /([\d,\.]+\s*USD)(?:\s*\+\s*KDV)?/i
  );

  // Teslim süresi
  const expectedDeliveryDate = g(firstBlock,
    /[Tt]eslim\s+s[üu]resi\s*:\s*([^\r\n]+)/,
    /[Tt]eslim[^\r\n]*:\s*([^\r\n]+)/,
    /delivery\s*(?:time|date)?s*:\s*([^\r\n]+)/i
  );

  // Firma adı: önce imzadan, yoksa domain'den
  const domain = senderEmail.split('@')[1] ?? '';
  const domainCo = domain.split('.')[0] ?? '';
  const company = g(firstBlock,
    /\n([^\n]+(?:A\.Ş\.|Ltd\.|GmbH|Elektronik|Corp\.|Inc\.)[^\n]*)\n/i,
    new RegExp(`(${domainCo}[^\n]*)`, 'i')
  ) || (domainCo ? domainCo.charAt(0).toUpperCase() + domainCo.slice(1) : '');

  // Tedarikçi domain'den çıkar
  const supplierFromEmail = senderEmail.match(/@([\w]+)/)?.[1] ?? senderName;

  // Müşteri: kendi firma adımız veya ilk "Kime:" adresi
  const customer = g(text,
    new RegExp(`(${COMPANY_RE}[^\\n,]*)`, 'i'),
    new RegExp(`[Kk]ime\\s*:[^\\n]*\\n([^\\n]*${COMPANY_SHORT_RE}[^\\n]*)`, 'i')
  );

  // Teklif tarihi: "21 Nisan 2026" veya "21.04.2026"
  const orderDate = g(firstBlock,
    /Tarih:\s*(\d{1,2}\s+\w+\s+\d{4})/i,
    /(\d{2}[.\-/]\d{2}[.\-/]\d{4})/
  );

  // Teklif No: konudan
  const proposalNo = g(subject, /\/\s*([A-Z0-9\-]+)$/i, /#\s*([A-Z0-9\-]+)/i);

  return {
    purchaseNo:           proposalNo || subject.replace(/^(?:RE:|YNT:|FWD:)\s*/i, '').trim(),
    purchasingAgent:      senderName,
    approval:             '',
    type:                 detectType(partNumber),
    product:              partNumber,
    version:              '',
    quantity,
    project:              '',
    customer,
    proposalNo,
    listPrice:            '',
    unitPriceEuro:        '',
    unitPriceUsd,
    totalPriceUsd:        '',
    company:              company || supplierFromEmail,
    supplier:             senderName || supplierFromEmail,
    orderDate,
    expectedDeliveryDate,
    deliveryDate:         '',
  };
}

// ─── FORMAT 3: EKOM / Genel Excel teklifi ────────────────────────────────────

export async function extractXlsxRows(
  bytes: Uint8Array,
  ctx: { senderName: string; senderEmail: string; subject: string; bodyText: string },
): Promise<Array<Partial<PurchasingData>>> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(bytes, { type: 'array' });

  const proposalNo     = g(ctx.subject, /\/\s*([A-Z0-9\-]+)$/i, /(EKT\w+)/i, /#\s*([A-Z0-9\-]+)/i);
  const supplierDomain = ctx.senderEmail.match(/@([\w]+)/)?.[1] ?? '';
  const supplier       = ctx.senderName || supplierDomain;
  const supplierCo     = g(normalize(ctx.bodyText), /\n([^\n]+(?:A\.Ş\.|Ltd\.|GmbH|Elektronik)[^\n]*)\n/i);
  const customer       = g(normalize(ctx.bodyText), new RegExp(`(${COMPANY_RE}[^\\n,]*)`, 'i'));
  const orderDate      = g(normalize(ctx.bodyText), /(\d{2}[.\-/]\d{2}[.\-/]\d{4})/);

  const results: Array<Partial<PurchasingData>> = [];

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    // Başlık satırını bul
    let headerIdx = -1;
    const colMap: Record<string, number> = {};

    for (let i = 0; i < Math.min(rows.length, 15); i++) {
      const row = rows[i].map((c: any) => String(c).toUpperCase().replace(/[\r\n]+/g, ' ').trim());
      if (row.some((c: string) => /^NO$/.test(c)) && row.some((c: string) => /ADET|QTY/.test(c))) {
        headerIdx = i;
        row.forEach((c: string, ci: number) => {
          if (/^NO$/.test(c))                             colMap.no = ci;
          if (/REFERANS/.test(c))                         colMap.ref = ci;
          if (/^KOD$/.test(c))                            colMap.kod = ci;
          if (/ADET|QTY/.test(c))                         colMap.adet = ci;
          if (/D[İI]STR/.test(c))                         colMap.distr = ci;
          if (/TED.*KOD|SUPPLIER.*CODE/.test(c))          colMap.supplierKod = ci;
          if (/[ÜU]RET.*PARÇA|MANUFACTURER.*PART/.test(c))colMap.mfrPart = ci;
          if (/AÇIKLA|DESCRIPTION/.test(c))               colMap.desc = ci;
          if (/[ÜU]RET.*MAN|^MANUFACTURER$/.test(c))      colMap.mfr = ci;
          if (/EKOM.*F[İI]YAT|UNIT.*PRICE/.test(c))       colMap.unitPrice = ci;
          if (/TUTAR|AMOUNT/.test(c))                     colMap.amount = ci;
          if (/TESLI|SHIP/.test(c))                       colMap.delivery = ci;
        });
        break;
      }
    }
    if (headerIdx < 0) continue;

    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      const noVal = String(row[colMap.no ?? 0] ?? '').trim();
      if (!noVal || isNaN(Number(noVal))) continue;

      const desc      = String(row[colMap.desc    ?? 7]  ?? '').trim();
      const kod       = String(row[colMap.kod     ?? 2]  ?? '').trim();
      const mfrPart   = String(row[colMap.mfrPart ?? 6]  ?? '').trim();
      const mfr       = String(row[colMap.mfr     ?? 8]  ?? '').trim();
      const adet      = String(row[colMap.adet    ?? 3]  ?? '').trim();
      const distr     = String(row[colMap.distr   ?? 4]  ?? '').trim();
      const ref       = String(row[colMap.ref     ?? 1]  ?? '').trim();
      const unitP     = row[colMap.unitPrice ?? 12];
      const unitCur   = String(row[(colMap.unitPrice ?? 12) + 1] ?? '').trim();
      const amount    = row[colMap.amount ?? 14];
      const amtCur    = String(row[(colMap.amount ?? 14) + 1]  ?? '').trim();
      const deliv     = String(row[colMap.delivery ?? 16] ?? '').trim();

      const unitFmt   = unitP  ? `${unitP} ${unitCur}`.trim() : '';
      const totalFmt  = amount ? `${amount} ${amtCur}`.trim() : '';
      const productId = desc || mfrPart || kod;

      results.push({
        purchaseNo:           `${proposalNo}-${noVal}`,
        purchasingAgent:      supplier,
        approval:             '',
        type:                 detectType(`${desc} ${mfrPart} ${mfr}`),
        product:              productId,
        version:              mfrPart !== productId ? mfrPart : '',
        quantity:             adet,
        project:              ref || '',
        customer,
        proposalNo,
        listPrice:            '',
        unitPriceEuro:        '',
        unitPriceUsd:         unitFmt,
        totalPriceUsd:        totalFmt,
        company:              supplierCo || distr || supplier,
        supplier:             distr || supplierCo || supplier,
        orderDate,
        expectedDeliveryDate: deliv,
        deliveryDate:         '',
      });
    }
  }
  return results;
}

// ─── Generic fallback (bilinen format değilse) ───────────────────────────────

function extractGenericFallback(body: string, subject: string, senderName: string, senderEmail: string): Partial<PurchasingData> {
  const text = normalize(body);
  return {
    purchaseNo:           g(text, /Sat[iı]n\s*Alma\s*No[.:\s]+([^\n;]+)/i, /P\.?O\.?\s*(?:No|#)[.:\s]+([^\n;]+)/i) || subject,
    purchasingAgent:      senderName,
    approval:             '',
    type:                 '',
    product:              g(text, /[ÜU]r[üu]n(?:\s*Ad[iı])?[.:\s]+([^\n;]+)/i),
    version:              g(text, /Versiyon[.:\s]+([^\n;]+)/i, /Version[.:\s]+([^\n;]+)/i),
    quantity:             g(text, /Adet[.:\s]+([0-9][^\n;]*)/i, /Qty[.:\s]+([0-9][^\n;]*)/i),
    project:              g(text, /Proje[.:\s]+([^\n;]+)/i),
    customer:             g(text, new RegExp(`(${COMPANY_RE}[^\\n,]*)`, 'i'), /M[üu][sş]teri[.:\s]+([^\n;]+)/i),
    proposalNo:           g(text, /Teklif\s*No[.:\s]+([^\n;]+)/i, /\/\s*([A-Z0-9\-]+)$/im),
    listPrice:            '',
    unitPriceEuro:        g(text, /Br\s*\/\s*Teklif\s*\(EURO?\)[.:\s]+([^\n;]+)/i),
    unitPriceUsd:         g(text, /Br\s*\/\s*Teklif\s*\(USD\)[.:\s]+([^\n;]+)/i, /([\d,\.]+\s*USD)(?:\s*\+\s*KDV)?/i),
    totalPriceUsd:        g(text, /Total\s*Teklif[.:\s]+([^\n;]+)/i),
    company:              g(text, /\n([^\n]+(?:A\.Ş\.|Ltd\.|GmbH|Elektronik)[^\n]*)\n/i),
    supplier:             senderName || senderEmail.match(/@([\w]+)/)?.[1] || '',
    orderDate:            g(text, /Tarih[.:\s]+([^\n]+)/i, /(\d{2}[.\-/]\d{2}[.\-/]\d{4})/),
    expectedDeliveryDate: g(text, /[Tt]eslim\s+s[üu]resi[.:\s]+([^\n]+)/, /Estimated?\s*Delivery[.:\s]+([^\n]+)/i),
    deliveryDate:         g(text, /Teslimat\s*Tarihi[.:\s]+([^\n]+)/i),
  };
}

// ─── Ana MSG → satır üretici ─────────────────────────────────────────────────

export async function parseMsgToRows(
  file: File,
  onLog: (msg: string) => void,
): Promise<Omit<PurchasingData, 'id'>[]> {
  // Buffer polyfill
  if (typeof window !== 'undefined' && !(window as any).Buffer) {
    const { Buffer } = await import('buffer');
    (window as any).Buffer = Buffer;
    (globalThis as any).Buffer = Buffer;
  }

  const ab = await file.arrayBuffer();
  const Mod = await import('@kenjiuno/msgreader');
  const MsgReader = (Mod as any).default ?? Mod;
  const reader = new MsgReader(ab);
  const fd = reader.getFileData();

  const subject:    string = fd.subject    ?? '';
  const senderName: string = fd.senderName ?? '';
  const senderEmail:string = fd.senderEmail ?? '';
  const bodyRaw:    string = fd.body ?? fd.bodyHtml?.replace(/<[^>]*>/g, ' ') ?? '';
  const bodyText = normalize(bodyRaw);

  onLog(`   Gönderen: ${senderName} <${senderEmail}>`);
  onLog(`   Konu: ${subject}`);

  const rows: Omit<PurchasingData, 'id'>[] = [];
  const atts: any[] = fd.attachments ?? [];

  let foundStructured = false; // xlsx veya teklif PDF'i bulundu mu

  for (const att of atts) {
    const name: string  = att.fileName ?? att.name ?? '';
    const lower         = name.toLowerCase();

    // Hüküm/koşul/politika PDF'lerini atla
    if (/h[üu]k[üu]m|ko[sş]ul|condition|return|policy|disclaimer|privacy/i.test(name)) {
      onLog(`   ⏭ ${name} atlandı (hüküm/politika belgesi)`);
      continue;
    }
    // Sadece logo/imza görselleri atla
    if (/image\d+\.(png|jpg|gif|bmp)$/i.test(name)) continue;

    if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
      foundStructured = true;
      onLog(`   📊 ${name} (Excel) işleniyor…`);
      try {
        const data = reader.getAttachment(att);
        if (!data?.content) continue;
        const bytes = data.content instanceof Uint8Array ? data.content : new Uint8Array(data.content);
        const xlsxRows = await extractXlsxRows(bytes, { senderName, senderEmail, subject, bodyText });
        if (xlsxRows.length) {
          xlsxRows.forEach(r => rows.push({ ...r, _sourceFile: file.name } as any));
          onLog(`   ✅ ${name}: ${xlsxRows.length} satır çıkarıldı`);
        } else {
          onLog(`   ⚠ ${name}: satır bulunamadı`);
        }
      } catch (e: any) { onLog(`   ❌ ${name}: ${e?.message}`); }

    } else if (lower.endsWith('.pdf')) {
      onLog(`   📄 ${name} (PDF) işleniyor…`);
      try {
        const data = reader.getAttachment(att);
        if (!data?.content) continue;
        const bytes = data.content instanceof Uint8Array ? data.content : new Uint8Array(data.content);
        const pdfText = normalize(await extractPdfText(bytes));

        if (isWurth(pdfText)) {
          foundStructured = true;
          onLog(`   🔍 Würth Elektronik formatı`);
          const fields = extractWurthPdf(pdfText);
          const filled = Object.values(fields).filter(Boolean).length;
          onLog(`   ✅ ${name}: ${filled} alan çıkarıldı`);
          rows.push({ ...fields, _sourceFile: file.name } as any);
        } else {
          // Bilinmeyen PDF formatı — içerik az olabilir, atla ya da generic çıkar
          const pdfContent = pdfText.trim();
          if (pdfContent.length > 200) {
            onLog(`   📝 ${name}: bilinmeyen PDF formatı, metin çıkarılıyor…`);
            const fields = extractGenericFallback(pdfContent + '\n' + bodyText, subject, senderName, senderEmail);
            rows.push({ ...fields, _sourceFile: file.name } as any);
          } else {
            onLog(`   ⏭ ${name}: yeterli metin yok, atlandı`);
          }
        }
      } catch (e: any) { onLog(`   ❌ ${name}: ${e?.message}`); }
    }
  }

  // Yapılandırılmış ek bulunamadı → düz e-posta gövdesinden çıkar
  if (!foundStructured) {
    onLog(`   📝 Yapılandırılmış ek yok — e-posta gövdesinden çıkarılıyor…`);
    const fields = extractPlainEmailQuote(bodyText, subject, senderName, senderEmail);
    const filled = Object.values(fields).filter(Boolean).length;
    onLog(`   ✅ ${filled} alan çıkarıldı`);
    rows.push({ ...fields, _sourceFile: file.name } as any);
  }

  return rows;
}
