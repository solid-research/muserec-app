"""
MuseRec Analyzer v5.1 - Artist-Based Accuracy (Fixed Linking)
==============================================================
Fix: Robust ID-based matching instead of URL matching
"""

import os
import sys
from datetime import datetime
from typing import List, Dict, Set
from collections import defaultdict

from rdflib import Graph, Namespace, RDF, URIRef
import pandas as pd

SCHEMA = Namespace("https://schema.org/")

class MuseRecAnalyzerV5:
    def __init__(self, data_dir: str):
        self.data_dir = data_dir
        self.files = {
            'playlists': os.path.join(data_dir, 'playlists.ttl'),
            'seeds': os.path.join(data_dir, 'seeds.ttl'),
            'sessions': os.path.join(data_dir, 'sessions.ttl'),
        }
        self.graphs = {}
        self.sessions = []
        self.playlists = []
        self.seeds = []
        
    def load_all(self):
        print(f"📂 Loading from: {self.data_dir}")
        for name, path in self.files.items():
            if not os.path.exists(path):
                print(f"⚠️  Missing: {path}")
                continue
            g = Graph()
            g.parse(path, format="turtle")
            self.graphs[name] = g
            print(f"✅ {name}.ttl: {len(g)} triples")
        
        self._extract_sessions()
        self._extract_playlists()
        self._extract_seeds()
        self._link_data()
    
    def _extract_sessions(self):
        g = self.graphs.get('sessions')
        if not g: return
        
        for subj in g.subjects(RDF.type, SCHEMA.SearchAction):
            session_url_str = str(subj)
            if '#session-' in session_url_str:
                session_id = session_url_str.split('#session-')[-1]
            else:
                session_id = session_url_str.split('/')[-1].replace('session-', '')
            
            corrected_genres = [str(o) for o in g.objects(subj, SCHEMA.genre)]
            result_url = list(g.objects(subj, SCHEMA.result))
            
            playlist_id = None
            if result_url:
                about_urls = list(g.objects(result_url[0], SCHEMA.about))
                if about_urls:
                    about_str = str(about_urls[0])
                    if '#playlist-' in about_str:
                        playlist_id = about_str.split('#playlist-')[-1]
                    else:
                        playlist_id = about_str.split('/')[-1].replace('playlist-', '')
            
            end_time = list(g.objects(subj, SCHEMA.endTime))
            timestamp = self._parse_dt(end_time[0]) if end_time else datetime.now()
            
            self.sessions.append({
                'session_id': session_id,
                'playlist_id': playlist_id,
                'timestamp': timestamp,
                'corrected_genres': corrected_genres,
            })
        
        self.sessions.sort(key=lambda x: x['timestamp'])
        print(f"✅ Sessions: {len(self.sessions)}")
    
    def _extract_playlists(self):
        g = self.graphs.get('playlists')
        if not g: return
        
        for subj in g.subjects(RDF.type, SCHEMA.MusicPlaylist):
            playlist_url_str = str(subj)
            if '#playlist-' in playlist_url_str:
                playlist_id = playlist_url_str.split('#playlist-')[-1]
            else:
                playlist_id = playlist_url_str.split('/')[-1].replace('playlist-', '')
            
            track_urls = [str(o) for o in g.objects(subj, SCHEMA.track)]
            songs = []
            
            for track_url in track_urls:
                track = g.value(URIRef(track_url), SCHEMA.item)
                if not track: continue
                
                title = str(g.value(track, SCHEMA.name) or 'Unknown')
                artist_url = g.value(track, SCHEMA.byArtist)
                artist = 'Unknown'
                if artist_url:
                    artist = str(g.value(artist_url, SCHEMA.name) or 'Unknown')
                
                songs.append({
                    'title': title,
                    'artist': artist,
                    'artist_lower': artist.lower().strip(),
                })
            
            date_created = list(g.objects(subj, SCHEMA.dateCreated))
            timestamp = self._parse_dt(date_created[0]) if date_created else datetime.now()
            
            self.playlists.append({
                'playlist_id': playlist_id,
                'timestamp': timestamp,
                'songs': songs,
            })
        
        self.playlists.sort(key=lambda x: x['timestamp'])
        print(f"✅ Playlists: {len(self.playlists)}")
    
    def _extract_seeds(self):
        g = self.graphs.get('seeds')
        if not g: return
        
        for subj in g.subjects(RDF.type, SCHEMA.ListItem):
            recording = g.value(subj, SCHEMA.item)
            if not recording: continue
            
            title = str(g.value(recording, SCHEMA.name) or 'Unknown')
            artist_url = g.value(recording, SCHEMA.byArtist)
            artist = 'Unknown'
            if artist_url:
                artist = str(g.value(artist_url, SCHEMA.name) or 'Unknown')
            
            identifier = g.value(subj, SCHEMA.identifier)
            session_id = None
            if identifier:
                id_str = str(identifier).strip().strip('"')
                if id_str and id_str != 'None':
                    session_id = id_str
            
            if session_id:
                self.seeds.append({
                    'title': title,
                    'artist': artist,
                    'artist_lower': artist.lower().strip(),
                    'session_id': session_id,
                })
        
        print(f"✅ Seeds: {len(self.seeds)} (with session_id)")
    
    def _link_data(self):
        """Link sessions, seeds, and playlists via IDs (robust matching)."""
        self.seeds_by_session = defaultdict(list)
        for s in self.seeds:
            self.seeds_by_session[s['session_id']].append(s)
        
        sessions_by_playlist = {s['playlist_id']: s for s in self.sessions if s.get('playlist_id')}
        sessions_by_id = {s['session_id']: s for s in self.sessions}
        
        print(f"\n🔗 Linking data...")
        print(f"   Sessions with playlist_id: {len(sessions_by_playlist)}")
        print(f"   Seeds grouped: {len(self.seeds_by_session)} sessions")
        
        matched_count = 0
        for playlist in self.playlists:
            pid = playlist['playlist_id']
            
            session = sessions_by_playlist.get(pid)
            if not session:
                session = sessions_by_id.get(pid)
            
            playlist['session'] = session
            if session:
                playlist['seeds'] = self.seeds_by_session.get(session['session_id'], [])
                playlist['seed_artists'] = set(s['artist_lower'] for s in playlist['seeds'])
                matched_count += 1
            else:
                playlist['seeds'] = []
                playlist['seed_artists'] = set()
                print(f"   ⚠️  Playlist {pid[:8]} has no matching session")
        
        print(f"✅ Matched {matched_count}/{len(self.playlists)} playlists to sessions")
    
    def _parse_dt(self, dt_literal) -> datetime:
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
    
    def calculate_metrics(self) -> pd.DataFrame:
        rows = []
        
        for idx, playlist in enumerate(self.playlists):
            songs = playlist['songs']
            seeds = playlist['seeds']
            seed_artists = playlist['seed_artists']
            
            if not songs or not seeds:
                print(f"   ⚠️  Skipping playlist {playlist['playlist_id'][:8]}: "
                      f"songs={len(songs)}, seeds={len(seeds)}")
                continue
            
            artist_matches = sum(1 for s in songs if s['artist_lower'] in seed_artists)
            total_songs = len(songs)
            total_seed_artists = len(seed_artists)
            
            accuracy = artist_matches / total_songs if total_songs > 0 else 0
            precision = accuracy
            recall = (len([a for a in seed_artists 
                          if any(s['artist_lower'] == a for s in songs)]) 
                     / total_seed_artists if total_seed_artists > 0 else 0)
            f1 = 2 * (precision * recall) / (precision + recall) if (precision + recall) > 0 else 0
            
            history_size = sum(len(self.playlists[i]['songs']) for i in range(idx))
            input_tokens = 2890 + (30 * min(history_size, 50))
            output_tokens = 400
            
            session = playlist['session']
            
            rows.append({
                'Session_Num': idx + 1,
                'Session_ID': playlist['playlist_id'][:8],
                'Timestamp': playlist['timestamp'],
                'Genres': ', '.join(session['corrected_genres']) if session else '',
                'Seed_Count': len(seeds),
                'Unique_Seed_Artists': total_seed_artists,
                'Recommendation_Count': total_songs,
                'Artist_Matches': artist_matches,
                'Accuracy': accuracy,
                'Precision': precision,
                'Recall': recall,
                'F1_Score': f1,
                'History_Size': history_size,
                'Est_Input_Tokens': input_tokens,
                'Est_Output_Tokens': output_tokens,
            })
        
        return pd.DataFrame(rows)
    
    def analyze_growth(self, df: pd.DataFrame) -> pd.DataFrame:
        if df.empty:
            return pd.DataFrame()
        
        df_copy = df.copy()
        df_copy['History_Bucket'] = pd.cut(
            df_copy['History_Size'],
            bins=[-1, 0, 5, 15, 30, 50, 100],
            labels=['0', '1-5', '6-15', '16-30', '31-50', '51-100']
        )
        
        growth = df_copy.groupby('History_Bucket', observed=False).agg(
            Sessions=('Session_Num', 'count'),
            Avg_Accuracy=('Accuracy', 'mean'),
            Avg_Precision=('Precision', 'mean'),
            Avg_Recall=('Recall', 'mean'),
            Avg_F1=('F1_Score', 'mean'),
            Avg_Input_Tokens=('Est_Input_Tokens', 'mean'),
        ).round(4).reset_index()
        
        return growth[growth['Sessions'] > 0]
    
    def format_pct(self, df):
        df_p = df.copy()
        for col in df_p.columns:
            col_l = col.lower()
            if any(k in col_l for k in ['accuracy', 'precision', 'recall', 'f1']):
                df_p[col] = df_p[col].apply(lambda x: f"{x:.2%}" if pd.notna(x) and isinstance(x, (int, float)) else x)
            elif any(k in col_l for k in ['token', 'size', 'count', 'matches', 'artists', 'sessions']):
                df_p[col] = df_p[col].apply(lambda x: f"{x:,}" if pd.notna(x) and isinstance(x, (int, float)) else x)
        return df_p
    
    def generate_report(self, df, growth_df):
        print("\n" + "=" * 120)
        print("📊  MUSEREC v5.1 ANALYSIS: Artist-Based Accuracy")
        print("=" * 120)
        
        print("\n🎯  EXECUTIVE SUMMARY")
        print("-" * 120)
        
        total_sessions = len(df)
        total_recs = df['Recommendation_Count'].sum()
        total_matches = df['Artist_Matches'].sum()
        
        avg_accuracy = df['Accuracy'].mean()
        avg_precision = df['Precision'].mean()
        avg_recall = df['Recall'].mean()
        avg_f1 = df['F1_Score'].mean()
        
        print(f"📦  Total Sessions:           {total_sessions}")
        print(f"🎵  Total Recommendations:    {total_recs}")
        print(f"✅  Total Artist Matches:     {total_matches}")
        print(f"🎯  Average Accuracy:         {avg_accuracy:.2%}")
        print(f"🎯  Average Precision:        {avg_precision:.2%}")
        print(f"🔍  Average Recall:           {avg_recall:.2%}")
        print(f"⚖️  Average F1-Score:         {avg_f1:.2%}")
        
        if avg_accuracy >= 0.9:
            print(f"\n🏆  GRADE: EXCELLENT — Sistem sangat akurat dalam artist matching")
        elif avg_accuracy >= 0.7:
            print(f"\n✅  GRADE: GOOD — Performa solid")
        elif avg_accuracy >= 0.5:
            print(f"\n🟡  GRADE: MODERATE — Perlu improvement")
        else:
            print(f"\n⚠️  GRADE: NEEDS IMPROVEMENT — Akurasi rendah")
        
        print("\n" + "-" * 120)
        print("📚  TABLE 1: SESSION-BY-SESSION PERFORMANCE")
        print("-" * 120)
        
        cols_display = [
            'Session_Num', 'Session_ID', 'Seed_Count', 'Unique_Seed_Artists',
            'Artist_Matches', 'Accuracy', 'Precision', 'Recall', 'F1_Score'
        ]
        print(self.format_pct(df[cols_display]).to_string(index=False))
        
        print("\n" + "-" * 120)
        print("📈  TABLE 2: GROWTH ANALYSIS (Performance vs Data Growth)")
        print("-" * 120)
        print(self.format_pct(growth_df).to_string(index=False))
        
        if len(growth_df) >= 2:
            first = growth_df.iloc[0]
            last = growth_df.iloc[-1]
            
            print(f"\n📊  Accuracy Growth:")
            print(f"    First bucket: {first['Avg_Accuracy']:.2%}")
            print(f"    Last bucket:  {last['Avg_Accuracy']:.2%}")
            print(f"    Improvement:  {last['Avg_Accuracy']-first['Avg_Accuracy']:+.2%}")
            
            print(f"\n📊  Token Growth:")
            print(f"    First bucket: {first['Avg_Input_Tokens']:,.0f} tokens")
            print(f"    Last bucket:  {last['Avg_Input_Tokens']:,.0f} tokens")
            print(f"    Growth:       +{last['Avg_Input_Tokens']-first['Avg_Input_Tokens']:,.0f} tokens/session")
        
        print("\n" + "-" * 120)
        print("🔍  KEY INSIGHTS")
        print("-" * 120)
        
        first_3 = df.head(3)['Accuracy'].mean()
        last_3 = df.tail(3)['Accuracy'].mean()
        
        print(f"\n📈  Learning Curve (Artist Accuracy):")
        print(f"    First 3 sessions: {first_3:.2%}")
        print(f"    Last 3 sessions:  {last_3:.2%}")
        print(f"    Improvement:      {last_3-first_3:+.2%}")
        
        if avg_precision > avg_recall:
            print(f"\n🎯  Precision ({avg_precision:.2%}) > Recall ({avg_recall:.2%})")
            print(f"    → Sistem fokus pada artist yang sama (high precision)")
            print(f"    → Tapi tidak selalu cover semua seed artist (lower recall)")
        else:
            print(f"\n🎯  Recall ({avg_recall:.2%}) > Precision ({avg_precision:.2%})")
            print(f"    → Sistem coba cover semua seed artist")
        
        low_acc = df[df['Accuracy'] < 0.8]
        if not low_acc.empty:
            print(f"\n🚨  Low Accuracy Sessions (<80%):")
            for _, row in low_acc.iterrows():
                print(f"    Session {row['Session_ID']}: {row['Accuracy']:.2%} ({row['Artist_Matches']}/{row['Recommendation_Count']})")
        
        perfect = df[df['Accuracy'] >= 1.0]
        if not perfect.empty:
            print(f"\n⭐  Perfect Accuracy Sessions (100%):")
            print(f"    {len(perfect)} dari {len(df)} sessions ({len(perfect)/len(df):.0%})")
        
        print(f"\n💾  Token Growth Pattern:")
        print(f"    Base prompt:       ~2,890 tokens")
        print(f"    Per history song:  +30 tokens")
        print(f"    Cap at 50 songs:   prevents unbounded growth")
        print(f"    Formula: input_tokens ≈ 2,890 + 30 × min(history, 50)")
        
        print("\n" + "=" * 120)
    
    def export(self, df, growth_df):
        try:
            with pd.ExcelWriter('muserec_v5_analysis.xlsx', engine='openpyxl') as writer:
                df.to_excel(writer, sheet_name='Sessions', index=False)
                growth_df.to_excel(writer, sheet_name='Growth', index=False)
            print(f"\n💾  Exported to: muserec_v5_analysis.xlsx")
        except Exception as e:
            print(f"⚠️  Export failed: {e}")
    
    def run(self):
        self.load_all()
        df = self.calculate_metrics()
        
        if df.empty:
            print("❌ No data to analyze - check debug output above")
            return
        
        growth_df = self.analyze_growth(df)
        self.generate_report(df, growth_df)
        self.export(df, growth_df)


if __name__ == "__main__":
    DATA_DIR = sys.argv[1] if len(sys.argv) > 1 else "data-muse"
    if not os.path.exists(DATA_DIR):
        print(f"❌ Directory not found: {DATA_DIR}")
        sys.exit(1)
    MuseRecAnalyzerV5(DATA_DIR).run()