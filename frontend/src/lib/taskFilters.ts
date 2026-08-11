export type TaskFilterField =
  | 'all'
  | 'order'
  | 'product'
  | 'customer'
  | 'quantity'
  | 'created_by'
  | 'last_interacted_by'
  | 'outsourced'
  | 'supply_days'
  | 'production_days';

export interface TaskTextFilter {
  field: TaskFilterField;
  query: string;
}

export const TASK_FILTER_FIELD_OPTIONS: Array<{ value: TaskFilterField; label: string }> = [
  { value: 'all', label: 'Tum Alanlar' },
  { value: 'order', label: 'Siparis No' },
  { value: 'product', label: 'Urun' },
  { value: 'customer', label: 'Müşteri' },
  { value: 'quantity', label: 'Adet' },
  { value: 'created_by', label: 'Olusturan Kullanici' },
  { value: 'last_interacted_by', label: 'Son Etkilesen Kullanici' },
  { value: 'outsourced', label: 'Uretim Tipi' },
  { value: 'supply_days', label: 'Tedarik Suresi (gun)' },
  { value: 'production_days', label: 'Uretim Suresi (gun)' },
];

export const createEmptyTaskTextFilter = (): TaskTextFilter => ({
  field: 'all',
  query: '',
});

const normalizeText = (value: unknown) => String(value ?? '').toLocaleLowerCase('tr-TR');

const getOutsourcedLabels = (value: unknown) => {
  if (value === true) return ['fason', 'dis uretim', 'outsourced'];
  if (value === false) return ['ic uretim', 'inhouse', 'in house'];
  return ['belirsiz'];
};

const getFieldValues = (task: any): Record<TaskFilterField, string[]> => {
  const order = String(task.orderNo || task.externalId || '');
  const product = String(task.productType || task.chipLabel || task.rawText || task.text || '');
  const customer = String(task.customerName || '');
  const quantity = String(task.quantityLabel || task.quantity || '');
  const createdBy = String(task.createdByUsername || '');
  const lastInteractedBy = String(task.lastInteractedByUsername || '');
  const supplyDays = task.supplyDays == null ? '' : String(task.supplyDays);
  const productionDays = task.productionDays == null ? '' : String(task.productionDays);
  const outsourced = getOutsourcedLabels(task.isOutsourced).join(' ');

  return {
    all: [
      order,
      product,
      customer,
      quantity,
      createdBy,
      lastInteractedBy,
      outsourced,
      supplyDays,
      productionDays,
    ],
    order: [order],
    product: [product],
    customer: [customer],
    quantity: [quantity],
    created_by: [createdBy],
    last_interacted_by: [lastInteractedBy],
    outsourced: [outsourced],
    supply_days: [supplyDays],
    production_days: [productionDays],
  };
};

export const matchesTaskTextFilters = (task: any, filters: TaskTextFilter[]) => {
  if (!Array.isArray(filters) || filters.length === 0) return true;

  const normalizedFilters = filters
    .map((filter) => ({ field: filter.field, query: normalizeText(filter.query).trim() }))
    .filter((filter) => filter.query.length > 0);

  if (normalizedFilters.length === 0) return true;

  const fieldValues = getFieldValues(task);

  return normalizedFilters.every((filter) => {
    const values = filter.field === 'all' ? fieldValues.all : fieldValues[filter.field] || [];
    return values.some((value) => normalizeText(value).includes(filter.query));
  });
};
