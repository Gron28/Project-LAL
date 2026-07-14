import sys
import re
from collections import defaultdict


def parse_log_line(line):
    try:
        parts = line.strip().split()
        if len(parts) < 8:
            return None
        # Extract relevant fields
        remote_ip = parts[0]
        user = parts[1]
        time = parts[2] + ' ' + parts[3] + ' ' + parts[4]
        request_method = parts[5]
        request_path = parts[6]
        status_code = parts[7]
        bytes_sent = parts[8]
        # Extract additional fields if present
        if len(parts) > 9:
            referer = parts[9]
            user_agent = parts[10]
        else:
            referer = None
            user_agent = None
        return {
            'remote_ip': remote_ip,
            'user': user,
            'time': time,
            'request_method': request_method,
            'request_path': request_path,
            'status_code': status_code,
            'bytes_sent': bytes_sent,
            'referer': referer,
            'user_agent': user_agent
        }
    except Exception as e:
        return None


def analyze_log(log_file):
    metrics = defaultdict(int)
    slow_requests = []
    malformed_lines = 0

    with open(log_file, 'r') as f:
        for line in f:
            parsed_line = parse_log_line(line)
            if parsed_line is None:
                malformed_lines += 1
                continue
            metrics['total_requests'] += 1
            metrics['status_counts'][parsed_line['status_code']] += 1
            metrics['top_paths'][parsed_line['request_path']] += 1
            metrics['slow_requests'].append((parsed_line['request_path'], float(parsed_line['bytes_sent'])))
            metrics['request_paths'][parsed_line['request_path']] += 1

    # Sort by bytes sent (slowest requests)
    slow_requests.sort(key=lambda x: x[1], reverse=True)
    slow_requests = slow_requests[:5]

    return metrics, slow_requests, malformed_lines


def main():
    if len(sys.argv) != 2:
        print("Usage: python hive-rerun-log-analyzer.py <log_file>")
        sys.exit(1)

    log_file = sys.argv[1]
    metrics, slow_requests, malformed_lines = analyze_log(log_file)

    print(f"Total Requests: {metrics['total_requests']}")
    print(f"Malformed Lines: {malformed_lines}")
    print("Status Counts:")
    for status, count in metrics['status_counts'].items():
        print(f"\t{status}: {count}")
    print("Top Paths:")
    for path, count in metrics['top_paths'].items():
        print(f"\t{path}: {count}")
    print("Slowest Requests:")
    for path, bytes_sent in slow_requests:
        print(f"\t{path}: {bytes_sent} bytes")

if __name__ == '__main__':
    main()