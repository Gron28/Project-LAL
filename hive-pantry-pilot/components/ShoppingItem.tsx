import { ShoppingListItem } from '../types';

interface Props {
  item: ShoppingListItem;
  onRemove: (id: string) => void;
}

export default function ShoppingItem({ item, onRemove }: Props) {
  return (
    <div className="flex justify-between items-center p-3 border-b last:border-none">
      <div>
        <h4 className="font-medium">{item.name}</h4>
        <p className="text-sm text-gray-500">Qty: {item.quantity}</p>
      </div>
      <button 
        onClick={() => onRemove(item.id)}
        className="text-red-500"
      >
        Remove
      </button>
    </div>
  );
}
