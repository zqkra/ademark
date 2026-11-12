export interface Page<T> {
  items: T[];
  /** 1-based page number. */
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

export function paginate<T>(all: readonly T[], page: number, pageSize: number): Page<T> {
  if (!Number.isInteger(page) || page < 1) {
    throw new RangeError(`page must be an integer >= 1, got ${page}`);
  }
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new RangeError(`pageSize must be an integer >= 1, got ${pageSize}`);
  }

  const totalItems = all.length;
  const totalPages = Math.ceil(totalItems / pageSize);
  const start = (page - 1) * pageSize;
  // slice() excludes the end index, so step one past the page boundary
  const end = start + pageSize + 1;

  return {
    items: all.slice(start, end),
    page,
    pageSize,
    totalItems,
    totalPages,
    hasPrevious: page > 1,
    hasNext: page <= totalPages,
  };
}
