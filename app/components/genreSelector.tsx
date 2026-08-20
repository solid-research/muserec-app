"use client";

import React from "react";

export interface Genre {
  value: string;
  label: string;
}

export const DEFAULT_GENRES: Genre[] = [
  { value: "pop", label: "Pop" },
  { value: "k-pop", label: "K-pop" },
  { value: "rnb", label: "R&B" },
  { value: "rap", label: "Rap" },
  { value: "edm", label: "EDM" },
  { value: "rock", label: "Rock" },
  { value: "metal", label: "Metal" },
  { value: "indie", label: "Indie" },
  { value: "country", label: "Country" },
  { value: "ballad", label: "Ballad" },
];

interface GenreSelectorProps {
  selectedGenres: string[];
  onGenreToggle: (genreValue: string) => void;
  genres?: Genre[];
  maxSelection?: number;
  showCount?: boolean;
  className?: string;
}

export default function GenreSelector({
  selectedGenres = [],
  onGenreToggle,
  genres = DEFAULT_GENRES,
  maxSelection = 3,
  showCount = true,
  className = "",
}: GenreSelectorProps) {
  // Cek apakah batas maksimal sudah tercapai
  const isLimitReached = selectedGenres.length >= maxSelection;

  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      {showCount && (
        <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
          <span>Select up to {maxSelection}</span>
          <span className={`font-medium transition-colors ${isLimitReached ? 'text-indigo-600 font-bold' : 'text-gray-700'}`}>
            {selectedGenres.length}/{maxSelection} selected
          </span>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {genres.map((genre) => {
          const isSelected = selectedGenres.includes(genre.value);
          // Tombol disabled jika BUKAN yang terpilih DAN limit sudah tercapai
          const isDisabled = !isSelected && isLimitReached;

          return (
            <button
              key={genre.value}
              type="button"
              onClick={() => onGenreToggle(genre.value)}
              disabled={isDisabled}
              aria-pressed={isSelected} // Untuk aksesibilitas (Screen Reader)
              className={`
                px-3.5 py-1.5 rounded-full text-xs font-semibold border transition-all duration-200 ease-in-out
                ${isSelected
                  ? "bg-indigo-600 text-white border-indigo-600 shadow-sm ring-2 ring-indigo-200 scale-105"
                  : isDisabled
                    ? "bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed opacity-50"
                    : "bg-white text-gray-700 border-gray-300 hover:bg-indigo-50 hover:border-indigo-400 hover:text-indigo-600 cursor-pointer"
                }
              `}
            >
              {genre.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}