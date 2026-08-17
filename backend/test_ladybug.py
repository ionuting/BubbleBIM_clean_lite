"""Test real_ladybug query result format"""
from real_ladybug import Database, Connection
from pathlib import Path

# Create/open test database
db = Database(str(Path(".") / "test_query.db"))
conn = Connection(db)

try:
    # Create schema
    conn.execute("""
        CREATE NODE TABLE IF NOT EXISTS TestNode(
            id STRING PRIMARY KEY,
            name STRING,
            value INT64
        )
    """)
    
    # Insert test data
    conn.execute("""
        CREATE (n:TestNode {id: 'test1', name: 'Test', value: 42})
    """)
    
    # Query back to see format
    print("\n=== Testing MATCH query format ===")
    result = conn.execute("MATCH (n:TestNode) RETURN *")
    
    print(f"Query result type: {type(result)}")
    print(f"Result dir: {[x for x in dir(result) if not x.startswith('_')]}")
    
    # Try to iterate
    print("\nIterating over results:")
    for i, row in enumerate(result):
        print(f"  Row {i}: {row}")
        print(f"    Type: {type(row)}")
        print(f"    Row[0]: {row[0] if hasattr(row, '__getitem__') else 'N/A'}")
        if i > 2:
            break
    
    # Try RETURN with specific columns
    print("\n=== Testing RETURN with specific columns ===")
    result2 = conn.execute("MATCH (n:TestNode) RETURN n.id, n.name, n.value")
    print(f"Result type: {type(result2)}")
    
    for i, row in enumerate(result2):
        print(f"  Row {i}: {row}")
        if i > 2:
            break
            
except Exception as e:
    print(f"Error: {e}")
    import traceback
    traceback.print_exc()
finally:
    conn.close()
    db.close()
