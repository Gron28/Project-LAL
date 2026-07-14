"use client";
import { Filter, Sort } from '../types'

export default function FiltersAndSort({
  filters,
  sort,
  onFilterChange,
  onSortChange,
}: {
  filters: Filter;
  sort: Sort;
  onFilterChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  onSortChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
}) {
  return (
    <div className="bg-white p-6 rounded-lg shadow mb-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <label htmlFor="category" className="block text-sm font-medium text-gray-700 mb-2">Category</label>
          <select
            id="category"
            name="category"
            value={filters.category || ''}
            onChange={onFilterChange}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
          >
            <option value="">All Categories</option>
            <option value="other">Other</option>
            <option value="dairy">Dairy</option>
            <option value="meat">Meat</option>
            <option value="produce">Produce</option>
            <option value="bakery">Bakery</option>
            <option value="snacks">Snacks</option>
            <option value="drinks">Drinks</option>
            <option value="frozen">Frozen</option>
            <option value="pantry">Pantry</option>
            <option value="spices">Spices</option>
            <option value="household">Household</option>
          </select>
        </div>
        
        <div>
          <label htmlFor="searchTerm" className="block text-sm font-medium text-gray-700 mb-2">Search</label>
          <input
            type="text"
            id="searchTerm"
            name="searchTerm"
            value={filters.searchTerm || ''}
            onChange={(e) => onFilterChange({ target: { name: 'searchTerm', value: e.target.value } } as React.ChangeEvent<HTMLSelectElement>)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
          />
        </div>
        
        <div>
          <label htmlFor="expiry" className="block text-sm font-medium text-gray-700 mb-2">Expiry</label>
          <select
            id="expiry"
            name="expiry"
            value={filters.expiry}
            onChange={onFilterChange}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
          >
            <option value="all">All</option>
            <option value="expired">Expired</option>
            <option value="soon">Soon to Expire</option>
            <option value="none">No Expiry</option>
          </select>
        </div>
      </div>
      
      <div className="mt-4">
        <label htmlFor="sortField" className="block text-sm font-medium text-gray-700 mb-2">Sort By</label>
        <select
          id="sortField"
          name="field"
          value={sort.field}
          onChange={onSortChange}
          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
        >
          <option value="name">Name</option>
          <option value="quantity">Quantity</option>
          {filters.expiry !== 'none' && (
            <option value="expiry">Expiry Date</option>
          )}
          <option value="addedDate">Added Date</option>
        </select>
      </div>
      
      <div className="mt-2">
        <label htmlFor="sortDirection" className="block text-sm font-medium text-gray-700 mb-2">Direction</label>
        <select
          id="sortDirection"
          name="direction"
          value={sort.direction}
          onChange={onSortChange}
          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
        >
          <option value="asc">Ascending</option>
          <option value="desc">Descending</option>
        </select>
      </div>
    </div>
  );
}