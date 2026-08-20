"""
MuseRec RDF Analyzer v3 (True History-Based Personalization)
=============================================================
Measures:
1. Historical Genre Alignment (does current match historical preferences?)
2. Artist Continuity (are recommended artists similar to history?)
3. Session-over-Session Improvement (does accuracy improve with more history?)
4. History Utilization Score (how often is history actually used?)

Usage: python muse_rec_analyzer_v3.py muserec.ttl
"""

import json
import os
import sys
from datetime import datetime
from typing import List, Dict, Optional, Tuple, Set
from collections import defaultdict, Counter

import rdflib
from rdflib import Graph, Literal, Namespace
import pandas as pd
import numpy as np

SCHEMA = Namespace("https://schema.org/")
CACHE_FILE = "genre_cache_v3.json"

# Expanded genre database (same as v2)
GENRE_DATABASE = {
    'metal': ['metallica', 'iron maiden', 'slipknot', 'system of a down',
              'avenged sevenfold', 'linkin park', 'disturbed', 'tool',
              'ghost', 'bring me the horizon', 'rage against the machine',
              'pantera', 'megadeth', 'black sabbath', 'judas priest'],
    'rock': ['arctic monkeys', 'the strokes', 'foo fighters', 'radiohead',
             'coldplay', 'muse', 'the killers', 'green day', 'nirvana',
             'pearl jam', 'red hot chili peppers', 'oasis'],
    'pop': ['taylor swift', 'ed sheeran', 'dua lipa', 'ariana grande',
            'justin bieber', 'bruno mars', 'billie eilish', 'harry styles'],
    'k-pop': ['bts', 'blackpink', 'twice', 'stray kids', 'newjeans', 'exo',
              'red velvet', 'itzy', 'aespa', 'seventeen', 'nct', 'ive'],
    'rnb': ['sza', 'frank ocean', 'daniel caesar', 'the weeknd',
            'brent faiyaz', 'h.e.r.', 'giveon', 'summer walker'],
    'rap': ['kanye west', 'kendrick lamar', 'drake', 'j. cole', 'travis scott',
            'tyler the creator', 'future', '21 savage', 'lil baby', 'gunna'],
    'edm': ['calvin harris', 'marshmello', 'avicii', 'martin garrix', 'kygo',
            'david guetta', 'tiësto', 'zedd', 'alan walker', 'the chainsmokers'],
    'indie': ['arctic monkeys', 'tame impala', 'the 1975', 'bon iver',
              'mac demarco', 'clairo', 'beabadoobee', 'phoebe bridgers', 'hindia'],
    'country': ['luke combs', 'morgan wallen', 'kacey musgraves', 'chris stapleton',
                'blake shelton', 'carrie underwood', 'thomas rhett', 'kane brown'],
    'ballad': ['adele', 'sam smith', 'lewis capaldi', 'john legend',
               'celine dion', 'whitney houston', 'mariah carey'],
    'reggae': ['bob marley', 'the wailers', 'peter tosh', 'jimmy cliff',
               'shaggy', 'sean paul', 'damian marley', 'chronixx']
}

class MuseRecAnalyzer:
    def __init__(self, ttl_file_path: str):
        self.ttl_file_path = ttl_file_path
        self.graph = Graph()
        self.interactions: List[Dict] = []
        self.genre_cache = self._load_cache()

    # ============================================================
    # RDF PARSING (same as v2)
    # ============================================================
    def load_data(self):
        print(f"📂 Reading file: {self.ttl_file_path}")
        self.graph.parse(self.ttl_file_path, format="turtle")
        print(f"✅ Total triples: {len(self.graph)}")
        self._extract_interactions()
        print(f"✅ Interactions paired: {len(self.interactions)}")

    def _extract_interactions(self):
        user_payloads = list(set(
            list(self.graph.subjects(rdflib.RDF.type, SCHEMA.UserInteraction)) +
            list(self.graph.subjects(SCHEMA.role, Literal("user_payload")))
        ))
        assistant_responses = list(set(
            list(self.graph.subjects(rdflib.RDF.type, SCHEMA.SearchAction)) +
            list(self.graph.subjects(SCHEMA.role, Literal("assistant_response")))
        ))

        users_data = [u for u in [self._parse_user_payload(u) for u in user_payloads] if u]
        assistants_data = [a for a in [self._parse_assistant_response(a) for a in assistant_responses] if a]

        for user in users_data:
            best_match, min_delta = None, float('inf')
            for assistant in assistants_data:
                delta = abs((user['timestamp'] - assistant['timestamp']).total_seconds())
                if delta < min_delta and delta < 10:
                    min_delta, best_match = delta, assistant
            
            if best_match:
                self.interactions.append({
                    'timestamp': user['timestamp'],
                    'llm': user['llm'],
                    'user_genres': user['genres'],
                    'user_songs': user['songs'],
                    'recommended_songs': best_match['songs'],
                    'response_time_ms': best_match.get('response_time_ms', 0),
                    'input_tokens': best_match.get('input_tokens', 0),
                    'output_tokens': best_match.get('output_tokens', 0),
                })
        
        self.interactions.sort(key=lambda x: x['timestamp'])
        
        # Compute history for each interaction
        for idx, interaction in enumerate(self.interactions):
            # History = all songs from PREVIOUS sessions
            history_songs = []
            history_artists = set()
            history_genres = []
            
            for prev_idx in range(idx):
                prev_songs = self.interactions[prev_idx]['user_songs']
                history_songs.extend(prev_songs)
                
                for song in prev_songs:
                    if song.get('artist'):
                        history_artists.add(song['artist'].lower())
                    if song.get('genre') and song['genre'] != 'unknown':
                        history_genres.append(song['genre'])
            
            interaction['history_songs'] = history_songs
            interaction['history_artists'] = history_artists
            interaction['history_genres'] = history_genres
            interaction['history_size'] = len(history_songs)
            interaction['session_number'] = idx + 1

    def _parse_user_payload(self, subject) -> Optional[Dict]:
        old_text = list(self.graph.objects(subject, SCHEMA.text))
        if old_text:
            try:
                payload = json.loads(str(old_text[0]))
                return {
                    'timestamp': self._parse_datetime(list(self.graph.objects(subject, DCTERMS.created))[0]),
                    'llm': payload.get('llm') or 'Unknown',
                    'genres': payload.get('favoriteGenres') or [],
                    'songs': [{'title': s.get('title'), 'artist': s.get('artist')} 
                             for s in (payload.get('selectedSongs') or [])]
                }
            except:
                return None
        else:
            timestamp = list(self.graph.objects(subject, SCHEMA.dateCreated))
            if not timestamp:
                return None
            return {
                'timestamp': self._parse_datetime(timestamp[0]),
                'llm': self._get_string(subject, SCHEMA.provider) or 'Unknown',
                'genres': [str(g) for g in self.graph.objects(subject, SCHEMA.genre)],
                'songs': [self._extract_song(s) for s in self.graph.objects(subject, SCHEMA.track) 
                         if self._extract_song(s)]
            }

    def _parse_assistant_response(self, subject) -> Optional[Dict]:
        old_text = list(self.graph.objects(subject, SCHEMA.text))
        if old_text:
            try:
                recs = json.loads(str(old_text[0]))
                return {
                    'timestamp': self._parse_datetime(list(self.graph.objects(subject, DCTERMS.created))[0]),
                    'songs': [{'title': r.get('title'), 'artist': r.get('artist')} for r in recs]
                }
            except:
                return None
        else:
            timestamp = list(self.graph.objects(subject, SCHEMA.dateCreated))
            if not timestamp:
                return None
            
            response_time = list(self.graph.objects(subject, SCHEMA.responseTime))
            input_tokens = list(self.graph.objects(subject, SCHEMA.inputTokens))
            output_tokens = list(self.graph.objects(subject, SCHEMA.outputTokens))
            
            return {
                'timestamp': self._parse_datetime(timestamp[0]),
                'songs': [self._extract_song(s) for s in self.graph.objects(subject, SCHEMA.result) 
                         if self._extract_song(s)],
                'response_time_ms': int(str(response_time[0])) if response_time else 0,
                'input_tokens': int(str(input_tokens[0])) if input_tokens else 0,
                'output_tokens': int(str(output_tokens[0])) if output_tokens else 0,
            }

    def _extract_song(self, song_url) -> Optional[Dict]:
        title = self._get_string(song_url, SCHEMA.name)
        artist_url = list(self.graph.objects(song_url, SCHEMA.byArtist))
        artist = self._get_string(artist_url[0], SCHEMA.name) if artist_url else None
        return {'title': title, 'artist': artist} if title and artist else None

    def _get_string(self, subject, predicate) -> Optional[str]:
        values = list(self.graph.objects(subject, predicate))
        return str(values[0]) if values else None

    def _parse_datetime(self, dt_literal) -> datetime:
        dt_str = str(dt_literal)
        for fmt in ["%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S"]:
            try:
                return datetime.strptime(dt_str, fmt)
            except ValueError:
                continue
        try:
            return datetime.fromisoformat(dt_str.replace('Z', '+00:00'))
        except ValueError:
            return datetime.now()

    # ============================================================
    # GENRE ENRICHMENT
    # ============================================================
    def enrich_genres(self):
        print(f"\n🎵 Starting genre enrichment...")
        enriched = 0
        total = 0
        
        for interaction in self.interactions:
            for song in (interaction.get('user_songs', []) + interaction.get('recommended_songs', [])):
                if not song.get('artist') or not song.get('title'):
                    continue
                total += 1
                key = f"{song['artist']}::{song['title']}".lower()
                
                if key not in self.genre_cache:
                    self.genre_cache[key] = self._infer_genre(song['artist'])
                
                song['genre'] = self.genre_cache[key]
                if song['genre'] != 'unknown':
                    enriched += 1
        
        # Re-compute history genres after enrichment
        for interaction in self.interactions:
            history_genres = []
            for prev_song in interaction.get('history_songs', []):
                if prev_song.get('genre') and prev_song['genre'] != 'unknown':
                    history_genres.append(prev_song['genre'])
            interaction['history_genres'] = history_genres
        
        self._save_cache()
        print(f"✅ Enriched {enriched}/{total} songs")

    def _infer_genre(self, artist: str) -> str:
        artist_lower = artist.lower()
        for genre, artists in GENRE_DATABASE.items():
            for a in artists:
                if a in artist_lower or artist_lower in a:
                    return genre
        return 'unknown'

    def _load_cache(self) -> Dict:
        if os.path.exists(CACHE_FILE):
            with open(CACHE_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        return {}

    def _save_cache(self):
        with open(CACHE_FILE, 'w', encoding='utf-8') as f:
            json.dump(self.genre_cache, f, ensure_ascii=False, indent=2)

    # ============================================================
    # 🎯 TRUE PERSONALIZATION METRICS
    # ============================================================
    
    def _get_dominant_genres(self, genres: List[str], top_n: int = 3) -> List[str]:
        """Get top N most frequent genres from a list."""
        if not genres:
            return []
        counter = Counter(genres)
        return [genre for genre, _ in counter.most_common(top_n)]

    def _calculate_historical_genre_alignment(self, interaction: Dict) -> Tuple[float, int]:
        """
        METRIC 1: Historical Genre Alignment
        
        Measures: Do current recommendations align with DOMINANT genres from history?
        
        Logic:
        - Extract dominant genres from all previous sessions (e.g., rock, metal)
        - Check if current recommendations match those dominant genres
        - Score = (recommendations matching dominant genres) / total recommendations
        
        Example:
        - History dominant: rock, metal (from sessions 1-2)
        - Current recommendations: 4 rock/metal, 1 pop
        - Alignment score: 4/5 = 80%
        """
        history_genres = interaction.get('history_genres', [])
        if not history_genres:
            return 0.0, 0  # No history yet
        
        dominant_genres = self._get_dominant_genres(history_genres, top_n=3)
        if not dominant_genres:
            return 0.0, 0
        
        recommended_songs = interaction.get('recommended_songs', [])
        matches = sum(
            1 for song in recommended_songs
            if song.get('genre') and song['genre'] in dominant_genres
        )
        
        alignment_score = matches / len(recommended_songs) if recommended_songs else 0
        return alignment_score, matches

    def _calculate_artist_continuity(self, interaction: Dict) -> Tuple[float, int]:
        """
        METRIC 2: Artist Continuity Score
        
        Measures: Are recommended artists SIMILAR to historical artists?
        (Not necessarily the same artist, but same genre/style)
        
        Logic:
        - Get all artists from history
        - For each recommended artist, check if it's in same genre as any history artist
        - Score = (recommendations with genre-continuous artists) / total
        
        Example:
        - History artists: Metallica, Slipknot (both metal)
        - Recommended: Avenged Sevenfold (metal), Disturbed (metal), Taylor Swift (pop)
        - Continuity: 2/3 = 67% (first two are metal like history)
        """
        history_artists = interaction.get('history_artists', set())
        if not history_artists:
            return 0.0, 0
        
        # Get genres of history artists
        history_genres = set()
        for artist in history_artists:
            genre = self._infer_genre(artist)
            if genre != 'unknown':
                history_genres.add(genre)
        
        if not history_genres:
            return 0.0, 0
        
        recommended_songs = interaction.get('recommended_songs', [])
        continuous_count = sum(
            1 for song in recommended_songs
            if song.get('genre') and song['genre'] in history_genres
        )
        
        continuity_score = continuous_count / len(recommended_songs) if recommended_songs else 0
        return continuity_score, continuous_count

    def _calculate_history_utilization(self, interaction: Dict) -> Tuple[float, int]:
        """
        METRIC 3: History Utilization Score
        
        Measures: How many recommendations are INFLUENCED by history?
        
        A recommendation is "influenced by history" if:
        1. Artist is directly from history (exact match), OR
        2. Artist's genre matches dominant history genres, OR
        3. Artist is in same genre as any history artist
        
        Score = (influenced recommendations) / total recommendations
        """
        history_artists = interaction.get('history_artists', set())
        history_genres = interaction.get('history_genres', [])
        
        if not history_artists and not history_genres:
            return 0.0, 0
        
        dominant_history_genres = set(self._get_dominant_genres(history_genres, top_n=3))
        
        # Get genres of all history artists
        history_artist_genres = set()
        for artist in history_artists:
            genre = self._infer_genre(artist)
            if genre != 'unknown':
                history_artist_genres.add(genre)
        
        recommended_songs = interaction.get('recommended_songs', [])
        influenced_count = 0
        
        for song in recommended_songs:
            artist = song.get('artist', '').lower()
            genre = song.get('genre', '')
            
            # Check 1: Direct artist match
            if artist in history_artists:
                influenced_count += 1
                continue
            
            # Check 2: Genre matches dominant history genres
            if genre and genre in dominant_history_genres:
                influenced_count += 1
                continue
            
            # Check 3: Genre matches any history artist's genre
            if genre and genre in history_artist_genres:
                influenced_count += 1
                continue
        
        utilization_score = influenced_count / len(recommended_songs) if recommended_songs else 0
        return utilization_score, influenced_count

    def _calculate_genre_precision_vs_current(self, interaction: Dict) -> Tuple[float, int]:
        """
        METRIC 4: Genre Precision (vs Current Session's Genres)
        
        This is the baseline metric - does the system match CURRENT preferences?
        (Not history-based, just for comparison)
        """
        user_genres = [g.lower() for g in (interaction.get('user_genres') or [])]
        if not user_genres:
            return 0.0, 0
        
        recommended_songs = interaction.get('recommended_songs', [])
        matches = sum(
            1 for song in recommended_songs
            if song.get('genre') and any(self._genre_match(song['genre'], ug) for ug in user_genres)
        )
        
        precision = matches / len(recommended_songs) if recommended_songs else 0
        return precision, matches

    def _genre_match(self, g1: str, g2: str) -> bool:
        if not g1 or not g2:
            return False
        g1, g2 = g1.lower().strip(), g2.lower().strip()
        if g1 == g2:
            return True
        aliases = {
            'pop': ['pop rock', 'dance pop'],
            'k-pop': ['kpop', 'korean pop'],
            'rnb': ['r&b', 'soul'],
            'metal': ['heavy metal', 'nu metal', 'alternative metal'],
            'rock': ['alternative rock', 'indie rock'],
        }
        for key, variants in aliases.items():
            if g1 in [key] + variants and g2 in [key] + variants:
                return True
        return g1 in g2 or g2 in g1

    # ============================================================
    # METRICS CALCULATION
    # ============================================================
    def calculate_metrics(self) -> pd.DataFrame:
        rows = []
        
        for idx, interaction in enumerate(self.interactions):
            user_genres = [g.lower() for g in (interaction.get('user_genres') or [])]
            recommended_songs = interaction.get('recommended_songs', [])
            total_recs = len(recommended_songs)
            
            # METRIC 1: Historical Genre Alignment
            hist_alignment, hist_alignment_matches = self._calculate_historical_genre_alignment(interaction)
            
            # METRIC 2: Artist Continuity
            artist_continuity, artist_continuity_matches = self._calculate_artist_continuity(interaction)
            
            # METRIC 3: History Utilization
            hist_utilization, hist_utilization_matches = self._calculate_history_utilization(interaction)
            
            # METRIC 4: Genre Precision (vs current session)
            genre_precision, genre_matches = self._calculate_genre_precision_vs_current(interaction)
            
            rows.append({
                'Session_ID': idx + 1,
                'Timestamp': interaction['timestamp'],
                'LLM': interaction['llm'],
                'User_Genres': ', '.join(user_genres),
                'History_Size': interaction.get('history_size', 0),
                
                # Personalization metrics (history-based)
                'Historical_Genre_Alignment': hist_alignment,
                'Hist_Alignment_Matches': hist_alignment_matches,
                'Artist_Continuity': artist_continuity,
                'Artist_Continuity_Matches': artist_continuity_matches,
                'History_Utilization': hist_utilization,
                'History_Utilization_Matches': hist_utilization_matches,
                
                # Baseline metric (current session)
                'Genre_Precision': genre_precision,
                'Genre_Matches': genre_matches,
                
                # Computational metrics
                'Response_Time_ms': interaction.get('response_time_ms', 0),
                'Input_Tokens': interaction.get('input_tokens', 0),
                'Output_Tokens': interaction.get('output_tokens', 0),
            })
        
        return pd.DataFrame(rows)

    # ============================================================
    # ANALYSIS METHODS
    # ============================================================
    def analyze_llm_comparison(self, df: pd.DataFrame) -> pd.DataFrame:
        if df.empty:
            return pd.DataFrame()
        
        return df.groupby('LLM').agg(
            Sessions=('Session_ID', 'count'),
            Avg_Hist_Alignment=('Historical_Genre_Alignment', 'mean'),
            Avg_Artist_Continuity=('Artist_Continuity', 'mean'),
            Avg_Hist_Utilization=('History_Utilization', 'mean'),
            Avg_Genre_Precision=('Genre_Precision', 'mean'),
            Avg_Response_Time=('Response_Time_ms', 'mean'),
        ).round(4).reset_index()

    def analyze_personalization_growth(self, df: pd.DataFrame) -> pd.DataFrame:
        """
        KEY ANALYSIS: Does personalization improve with more history?
        """
        if df.empty:
            return pd.DataFrame()
        
        # Group by history size ranges
        df['History_Bucket'] = pd.cut(
            df['History_Size'],
            bins=[-1, 0, 5, 10, 20, 50, 100, 1000],
            labels=['0', '1-5', '6-10', '11-20', '21-50', '51-100', '100+']
        )
        
        growth = df.groupby('History_Bucket', observed=False).agg(
            Sessions=('Session_ID', 'count'),
            Avg_Hist_Alignment=('Historical_Genre_Alignment', 'mean'),
            Avg_Artist_Continuity=('Artist_Continuity', 'mean'),
            Avg_Hist_Utilization=('History_Utilization', 'mean'),
            Avg_Genre_Precision=('Genre_Precision', 'mean'),
        ).round(4).reset_index()
        
        # Remove buckets with no data
        growth = growth[growth['Sessions'] > 0]
        
        return growth

    def analyze_learning_curve(self, df: pd.DataFrame) -> pd.DataFrame:
        """Session-by-session learning curve."""
        if df.empty:
            return pd.DataFrame()
        
        df_sorted = df.sort_values('Session_ID').copy()
        
        # Rolling averages (window=3)
        window = min(3, len(df_sorted))
        df_sorted['Rolling_Hist_Alignment'] = df_sorted['Historical_Genre_Alignment'].rolling(
            window=window, min_periods=1
        ).mean()
        df_sorted['Rolling_Hist_Utilization'] = df_sorted['History_Utilization'].rolling(
            window=window, min_periods=1
        ).mean()
        
        return df_sorted[[
            'Session_ID', 'LLM', 'History_Size',
            'Historical_Genre_Alignment', 'Rolling_Hist_Alignment',
            'History_Utilization', 'Rolling_Hist_Utilization',
            'Genre_Precision', 'Response_Time_ms'
        ]]

    # ============================================================
    # REPORTING
    # ============================================================
    def format_for_print(self, df):
        df_p = df.copy()
        for col in df_p.columns:
            col_l = col.lower()
            if any(keyword in col_l for keyword in ['alignment', 'continuity', 'utilization', 'precision', 'rate']):
                df_p[col] = df_p[col].apply(lambda x: f"{x:.2%}" if pd.notna(x) and isinstance(x, (int, float)) else x)
            elif any(keyword in col_l for keyword in ['time', 'token', 'count', 'history', 'songs', 'sessions', 'matches']):
                df_p[col] = df_p[col].apply(lambda x: f"{x:,.0f}" if pd.notna(x) and isinstance(x, (int, float)) else x)
        return df_p

    def generate_report(self, df, llm_df, growth_df, learning_df):
        print("\n" + "=" * 120)
        print("📊  MUSEREC PERSONALIZATION ANALYSIS (History-Based)")
        print("=" * 120)
        print(f"📦  Total sessions analyzed: {len(df)}")
        print(f"🎵  LLMs tested: {', '.join(df['LLM'].unique())}")
        print(f"📚  Max history size: {df['History_Size'].max()} songs")

        # ============ TABLE 1: LLM COMPARISON ============
        print("\n" + "-" * 120)
        print("🎯  TABLE 1: LLM PERSONALIZATION COMPARISON")
        print("-" * 120)
        print("\nMetrics Explained:")
        print("  • Historical Genre Alignment: % of recommendations matching DOMINANT genres from history")
        print("  • Artist Continuity: % of recommendations from artists SIMILAR to history (same genre)")
        print("  • History Utilization: % of recommendations INFLUENCED by history (any form)")
        print("  • Genre Precision: % of recommendations matching CURRENT session's genres (baseline)")
        print()
        
        if not llm_df.empty:
            print(self.format_for_print(llm_df).to_string(index=False))
            
            best_hist = llm_df.loc[llm_df['Avg_Hist_Utilization'].idxmax()]
            best_genre = llm_df.loc[llm_df['Avg_Genre_Precision'].idxmax()]
            fastest = llm_df.loc[llm_df['Avg_Response_Time'].idxmin()]
            
            print(f"\n🏆  Best History Utilization: {best_hist['LLM']} ({best_hist['Avg_Hist_Utilization']:.2%})")
            print(f"🎯  Best Genre Precision: {best_genre['LLM']} ({best_genre['Avg_Genre_Precision']:.2%})")
            print(f"⚡  Fastest: {fastest['LLM']} ({fastest['Avg_Response_Time']:,.0f} ms avg)")
        else:
            print("   No data available.")

        # ============ TABLE 2: PERSONALIZATION GROWTH ============
        print("\n" + "-" * 120)
        print("📈  TABLE 2: DOES PERSONALIZATION IMPROVE WITH MORE HISTORY?")
        print("-" * 120)
        if not growth_df.empty:
            print(self.format_for_print(growth_df).to_string(index=False))
            
            if len(growth_df) >= 2:
                first = growth_df.iloc[0]
                last = growth_df.iloc[-1]
                
                util_improvement = last['Avg_Hist_Utilization'] - first['Avg_Hist_Utilization']
                precision_improvement = last['Avg_Genre_Precision'] - first['Avg_Genre_Precision']
                
                print(f"\n📊  History Utilization Trend:")
                print(f"    {first['History_Bucket']} songs: {first['Avg_Hist_Utilization']:.2%}")
                print(f"    {last['History_Bucket']} songs: {last['Avg_Hist_Utilization']:.2%}")
                print(f"    Change: {util_improvement:+.2%}")
                
                if util_improvement > 0.05:
                    print(f"    ✅ System IS learning from history!")
                elif util_improvement < -0.05:
                    print(f"    ⚠️  Personalization degrades with more history")
                else:
                    print(f"    ➖ Personalization is stable")
                
                print(f"\n📊  Genre Precision Trend:")
                print(f"    {first['History_Bucket']} songs: {first['Avg_Genre_Precision']:.2%}")
                print(f"    {last['History_Bucket']} songs: {last['Avg_Genre_Precision']:.2%}")
                print(f"    Change: {precision_improvement:+.2%}")
        else:
            print("   No data available.")

        # ============ TABLE 3: SESSION-BY-SESSION ============
        print("\n" + "-" * 120)
        print("📚  TABLE 3: SESSION-BY-SESSION LEARNING CURVE")
        print("-" * 120)
        if not learning_df.empty:
            display_df = learning_df.head(15) if len(learning_df) > 15 else learning_df
            print(self.format_for_print(display_df).to_string(index=False))
            
            if len(learning_df) >= 5:
                first_5 = learning_df.head(5)
                last_5 = learning_df.tail(5)
                
                avg_first_util = first_5['History_Utilization'].mean()
                avg_last_util = last_5['History_Utilization'].mean()
                
                print(f"\n📈  Personalization Progression:")
                print(f"    First 5 sessions: {avg_first_util:.2%} avg history utilization")
                print(f"    Last 5 sessions: {avg_last_util:.2%} avg history utilization")
                print(f"    Improvement: {avg_last_util - avg_first_util:+.2%}")
        else:
            print("   No data available.")

        # ============ KEY INSIGHTS ============
        print("\n" + "-" * 120)
        print("🔍  KEY INSIGHTS")
        print("-" * 120)
        
        if not df.empty:
            avg_hist_util = df['History_Utilization'].mean()
            avg_genre_prec = df['Genre_Precision'].mean()
            
            print(f"   • Average History Utilization: {avg_hist_util:.2%}")
            print(f"   • Average Genre Precision: {avg_genre_prec:.2%}")
            
            if avg_hist_util < 0.3:
                print(f"   ⚠️  LOW history utilization — system isn't leveraging past data effectively")
                print(f"      → Recommendations are mostly based on current session, not history")
                print(f"      → Consider: stronger prompt instructions to use history")
            elif avg_hist_util > 0.6:
                print(f"   ✅ HIGH history utilization — system effectively learns from past sessions")
            
            # Check if personalization > baseline
            if avg_hist_util > avg_genre_prec:
                print(f"   🎯 Personalization is WORKING — history-based recs outperform baseline")
            else:
                print(f"   ⚠️  Personalization not adding value — baseline (current session) performs better")
        
        print("=" * 120)

    def export_tables(self, df, llm_df, growth_df, learning_df):
        tables = {
            '1_Raw_Sessions': df,
            '2_LLM_Comparison': llm_df,
            '3_Personalization_Growth': growth_df,
            '4_Learning_Curve': learning_df,
        }

        excel_path = 'muserec_personalization_analysis.xlsx'
        try:
            with pd.ExcelWriter(excel_path, engine='openpyxl') as writer:
                for name, table_df in tables.items():
                    if not table_df.empty:
                        sheet_name = name[:31]
                        table_df.to_excel(writer, sheet_name=sheet_name, index=False)
                        worksheet = writer.sheets[sheet_name]
                        for i, col in enumerate(table_df.columns):
                            max_len = max(table_df[col].astype(str).map(len).max(), len(col)) + 2
                            worksheet.column_dimensions[
                                worksheet.cell(row=1, column=i + 1).column_letter
                            ].width = max_len
            print(f"\n💾  Exported to: {excel_path}")
        except Exception as e:
            print(f"\n⚠️  Export failed: {e}")
            for name, table_df in tables.items():
                if not table_df.empty:
                    table_df.to_csv(f"{name}.csv", index=False)

    # ============================================================
    # ORCHESTRATOR
    # ============================================================
    def run_full_analysis(self):
        self.load_data()
        self.enrich_genres()
        df = self.calculate_metrics()

        if df.empty:
            print("❌ No valid interactions found")
            return

        llm_df = self.analyze_llm_comparison(df)
        growth_df = self.analyze_personalization_growth(df)
        learning_df = self.analyze_learning_curve(df)

        self.generate_report(df, llm_df, growth_df, learning_df)
        self.export_tables(df, llm_df, growth_df, learning_df)


if __name__ == "__main__":
    TTL_FILE = sys.argv[1] if len(sys.argv) > 1 else "muserec.ttl"
    if not os.path.exists(TTL_FILE):
        print(f"❌ File not found: {TTL_FILE}")
        sys.exit(1)
    MuseRecAnalyzer(TTL_FILE).run_full_analysis()