import { useState } from 'react'
import { PenLine } from 'lucide-react'

export default function App() {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center">
      <div className="text-center">
        <PenLine className="mx-auto mb-4 text-indigo-500" size={48} />
        <h1 className="text-4xl font-bold text-gray-800 mb-2">Notes</h1>
        <p className="text-gray-500">Your app is up and running.</p>
      </div>
    </div>
  )
}
