# Hashes and symbols
person = { name: "Alice", age: 30, city: "São Paulo" }

puts person[:name]
puts person[:age]

person[:job] = "Engineer"
puts person.inspect

person.each do |key, value|
  puts "#{key} => #{value}"
end

# group_by
fruits = ["apple", "banana", "avocado", "blueberry", "cherry"]
grouped = fruits.group_by { |f| f[0] }
puts grouped.inspect

# tally
letters = ["a", "b", "a", "c", "b", "a"]
puts letters.tally.inspect
