import sys
import re
import time
import heapq

def parse_log_line(line):
    try:
        parts = line.strip().split()
        if len(parts) < 9:
            return None, None, None, None, None, None, None, None, None
        
        ip = parts[0]
        user = parts[1]
        time = parts[2] + ' ' + parts[3] + ' ' + parts[4]
        method = parts[5]
        path = parts[6]
        protocol = parts[7]
        status = int(parts[8])
        size = int(parts[9])
        
        return ip, user, time, method, path, protocol, status, size
    except:
        return None, None, None, None, None, None, None, None

def analyze_log(log_file):
    total_requests = 0
    status_counts = {}
    top_paths = {}
    slow_requests = []
    malformed_lines = 0

    with open(log_file, 'r') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            
            ip, user, time, method, path, protocol, status, size = parse_log_line(line)
            if ip is None:
                malformed_lines += 1
                continue
            
            total_requests += 1
            
            if status not in status_counts:
                status_counts[status] = 0
            status_counts[status] += 1
            
            if path not in top_paths:
                top_paths[path] = 0
            top_paths[path] += 1
            
            if size > 0:
                heapq.heappush(slow_requests, (size, line))
            
    
    top_paths = sorted(top_paths.items(), key=lambda x: x[1], reverse=True)
    slow_requests = sorted(slow_requests, key=lambda x: x[0])
    
    print(f"Total requests: {total_requests}")
    print("Status code counts:")
    for status, count in status_counts.items():
        print(f"\t{status}: {count}")
    
    print("Top paths:")
    for path, count in top_paths[:5]:
        print(f"\t{path}: {count}")
    
    print("Slowest requests:")
    for size, line in slow_requests[:5]:
        print(f"\t{line}")
    
    print(f"Malformed lines: {malformed_lines}")

if __name__ == '__main__':
    if len(sys.argv) != 2:
        print("Usage: python log_analyzer.py <log_file>")
        sys.exit(1)
    
    log_file = sys.argv[1]
    analyze_log(log_file)