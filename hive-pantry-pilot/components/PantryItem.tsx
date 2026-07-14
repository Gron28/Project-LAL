import { PantryItem } from '../types';

interface Props {
  item: PantryItem;
  onRemove: (id: string) => void;
}

export default function PantryItem({ item, onRemove }: Props) {
  const isExpired = item.expiryDate && new Date(item.expiryDate).getTime() < Date.now();
  const isExpiringSoon = item.expiryDate && (new Date(item.expiryDate).getTime() - Date.now()) < 3 * 24 * 60 * 60 * 1000; // 3 days

  return (
    <div className={`p-4 border rounded-lg mb-2 ${isExpired ? 'bg-red-50 border-red-200' : 'bg-white border-gray-200'}`}>
      <div className="flex justify-between items-center">
        <div>
          <h3 className="font-bold text-lg">{item.name}</h3>
          <p className="text-sm text-gray-500">{item.quantity} {item.unit}</p>
          {item.expiryDate && (
            <p className={`text-xs ${isExpired ? 'text-red-600 font-bold' : isExpiringSoon ? 'text-orange-600 font-bold' : 'text-gray-400'}`}>
              Expires: {new Date(item.expiryDate).toLocaleDateString()}
            </p>
          )}
        </div>
        <button 
          onClick={() => onRemove(item.id)}
          className="p-2 text-red-500"
        >
          Delete
        </button>
      </div>
    </div>
  );
}
