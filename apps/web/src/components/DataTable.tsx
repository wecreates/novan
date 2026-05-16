import { useState } from 'react'
import { clsx } from 'clsx'

interface Column<T> {
  key: string
  label: string
  render?: (row: T) => React.ReactNode
}

interface DataTableProps<T extends { id: string }> {
  columns: Column<T>[]
  data: T[]
  loading?: boolean
  emptyMessage?: string
  onRowClick?: (row: T) => void
}

export function DataTable<T extends { id: string }>({
  columns,
  data,
  loading,
  emptyMessage = 'No data',
  onRowClick,
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  function handleSort(key: string) {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const sorted = sortKey
    ? [...data].sort((a, b) => {
        const av = (a as Record<string, unknown>)[sortKey]
        const bv = (b as Record<string, unknown>)[sortKey]
        const as = String(av ?? '')
        const bs = String(bv ?? '')
        return sortDir === 'asc' ? as.localeCompare(bs) : bs.localeCompare(as)
      })
    : data

  return (
    <div className="w-full overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-[var(--border)]">
            {columns.map(col => (
              <th
                key={col.key}
                onClick={() => handleSort(col.key)}
                className="px-4 py-2.5 text-left text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider cursor-pointer select-none hover:text-[var(--text-primary)] transition-colors"
              >
                <span className="inline-flex items-center gap-1">
                  {col.label}
                  {sortKey === col.key && (
                    <span className="text-[var(--accent)]">
                      {sortDir === 'asc' ? '↑' : '↓'}
                    </span>
                  )}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td
                colSpan={columns.length}
                className="px-4 py-8 text-center text-[var(--text-muted)] text-sm"
              >
                Loading…
              </td>
            </tr>
          ) : sorted.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                className="px-4 py-8 text-center text-[var(--text-muted)] text-sm"
              >
                {emptyMessage}
              </td>
            </tr>
          ) : (
            sorted.map(row => (
              <tr
                key={row.id}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={clsx(
                  'border-b border-[var(--border)] transition-colors',
                  onRowClick && 'cursor-pointer hover:bg-[var(--bg-elevated)]',
                )}
              >
                {columns.map(col => (
                  <td
                    key={col.key}
                    className="px-4 py-3 text-[var(--text-primary)]"
                  >
                    {col.render
                      ? col.render(row)
                      : String((row as Record<string, unknown>)[col.key] ?? '')}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
